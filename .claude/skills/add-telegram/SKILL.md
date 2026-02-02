---
name: add-telegram
description: Add Telegram as an input channel for NanoClaw. Creates a Telegram bot that routes messages to the same container agents as WhatsApp. Supports private chats and group conversations.
---

# Add Telegram Integration

This skill adds Telegram as an input channel for NanoClaw. Messages from Telegram are routed to the same container agents as WhatsApp.

## Initial Questions

Ask the user:

> How do you want to use Telegram with NanoClaw?
>
> **Option 1: Private Chat Only**
> - Bot responds to direct messages
> - Each user gets their own conversation context
> - Simpler setup
>
> **Option 2: Groups + Private**
> - Bot can be added to Telegram groups
> - Responds when mentioned or with trigger word
> - Groups can be registered like WhatsApp groups

Store their choice and proceed.

Also ask:

> Should Telegram share conversation context with WhatsApp?
>
> **Option A: Separate Contexts**
> - Telegram conversations are independent
> - Different memory from WhatsApp groups
>
> **Option B: Unified Main Channel**
> - Telegram private chat with you shares context with WhatsApp main channel
> - Like having two interfaces to the same assistant

---

## Prerequisites

### 1. Create Telegram Bot

**USER ACTION REQUIRED**

Tell the user:

> Let's create your Telegram bot:
>
> 1. Open Telegram and search for **@BotFather**
> 2. Send `/newbot`
> 3. Choose a display name (e.g., "m87 Assistant")
> 4. Choose a username ending in `bot` (e.g., "m87_assistant_bot")
> 5. BotFather will give you an API token - copy it
>
> Paste the bot token here (looks like `123456789:ABC-DEF...`)

Store the token. Write it to `.env`:

```bash
# Read existing .env content
EXISTING=$(cat .env 2>/dev/null || echo "")

# Append Telegram token if not already present
if ! grep -q "TELEGRAM_BOT_TOKEN" .env 2>/dev/null; then
  echo "" >> .env
  echo "# Telegram Bot" >> .env
  echo "TELEGRAM_BOT_TOKEN=TOKEN_HERE" >> .env
fi
```

Replace `TOKEN_HERE` with the actual token the user provided.

Verify:

```bash
grep "TELEGRAM_BOT_TOKEN" .env
```

### 2. Configure Bot Settings (Optional)

Tell the user:

> Optional: Configure your bot in BotFather:
>
> - `/setdescription` - What users see before starting chat
> - `/setabouttext` - Bot's bio
> - `/setuserpic` - Bot's profile picture
>
> For groups, you may want to:
> - `/setjoingroups` - Enable if using Option 2
> - `/setprivacy` - Disable if bot should see all group messages (not just commands)
>
> Let me know when you're ready to continue.

---

## Implementation

### Step 1: Install Telegram Library

```bash
npm install telegraf
```

### Step 2: Add Telegram Types

Read `src/types.ts` and add:

```typescript
export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;        // For groups
  username?: string;     // For private chats
  firstName?: string;
}

export interface RegisteredTelegramChat {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  platform: 'telegram';
  chatType: 'private' | 'group';
}
```

### Step 3: Add Telegram Configuration

Read `src/config.ts` and add:

```typescript
export const TELEGRAM_CONFIG = {
  enabled: true,
  triggerPattern: /^@m87\b/i,  // Same trigger as WhatsApp, adjust if different
  privateChatsEnabled: true,
  groupsEnabled: true,  // Set based on user's choice
  unifiedMainChannel: false,  // Set based on user's choice
};
```

Adjust values based on user's earlier answers.

### Step 4: Create Telegram Module

Create `src/telegram.ts`:

```typescript
import { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import { TELEGRAM_CONFIG, DATA_DIR, GROUPS_DIR, ASSISTANT_NAME } from './config.js';
import { runContainerAgent } from './container-runner.js';
import { RegisteredGroup } from './types.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

let bot: Telegraf | null = null;
const telegramSessions: Record<string, string> = {};

// Load registered Telegram chats
function loadTelegramChats(): Record<string, RegisteredGroup> {
  const filePath = path.join(DATA_DIR, 'registered_telegram.json');
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }
  return {};
}

function saveTelegramChats(chats: Record<string, RegisteredGroup>): void {
  const filePath = path.join(DATA_DIR, 'registered_telegram.json');
  fs.writeFileSync(filePath, JSON.stringify(chats, null, 2));
}

// Get or create folder for a Telegram chat
function getGroupFolder(chatId: number, chatType: string, title?: string): string {
  const chats = loadTelegramChats();
  const key = `tg:${chatId}`;

  if (chats[key]) {
    return chats[key].folder;
  }

  // Auto-register private chats
  if (chatType === 'private') {
    const folder = `telegram-private-${chatId}`;
    chats[key] = {
      name: title || `Telegram ${chatId}`,
      folder,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString()
    };
    saveTelegramChats(chats);

    // Create folder
    const groupDir = path.join(GROUPS_DIR, folder);
    fs.mkdirSync(groupDir, { recursive: true });

    return folder;
  }

  return '';  // Groups must be manually registered
}

async function handleMessage(ctx: Context): Promise<void> {
  if (!ctx.message || !('text' in ctx.message)) return;

  const text = ctx.message.text;
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type;
  const chatTitle = ctx.chat && 'title' in ctx.chat ? ctx.chat.title : undefined;
  const fromUser = ctx.from?.username || ctx.from?.first_name || 'Unknown';

  if (!chatId || !chatType) return;

  logger.info({ chatId, chatType, from: fromUser }, 'Telegram message received');

  // Check if this is a private chat or registered group
  const isPrivate = chatType === 'private';
  const chats = loadTelegramChats();
  const key = `tg:${chatId}`;
  const isRegistered = !!chats[key];

  // For groups, check trigger pattern
  if (!isPrivate && !isRegistered) {
    logger.debug({ chatId }, 'Ignoring message from unregistered group');
    return;
  }

  if (!isPrivate && !TELEGRAM_CONFIG.triggerPattern.test(text)) {
    logger.debug('Message does not match trigger pattern');
    return;
  }

  // Get folder (auto-creates for private chats)
  let folder: string;
  if (TELEGRAM_CONFIG.unifiedMainChannel && isPrivate) {
    folder = 'main';  // Share with WhatsApp main
  } else {
    folder = getGroupFolder(chatId, chatType, chatTitle);
  }

  if (!folder) {
    logger.warn({ chatId }, 'No folder for chat, ignoring');
    return;
  }

  // Remove trigger from message
  const prompt = isPrivate ? text : text.replace(TELEGRAM_CONFIG.triggerPattern, '').trim();

  // Send typing indicator
  await ctx.sendChatAction('typing');

  try {
    // Build group config
    const groupConfig: RegisteredGroup = chats[key] || {
      name: folder,
      folder,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString()
    };

    const output = await runContainerAgent(groupConfig, {
      prompt,
      sessionId: telegramSessions[folder],
      groupFolder: folder,
      chatJid: key,
      isMain: folder === 'main',
      isScheduledTask: false
    });

    if (output.newSessionId) {
      telegramSessions[folder] = output.newSessionId;
    }

    if (output.status === 'success' && output.result) {
      // Split long messages (Telegram limit is 4096 chars)
      const maxLen = 4000;
      const result = output.result;

      if (result.length <= maxLen) {
        await ctx.reply(result, { parse_mode: 'Markdown' }).catch(() => {
          // Retry without markdown if it fails
          ctx.reply(result);
        });
      } else {
        // Split into chunks
        for (let i = 0; i < result.length; i += maxLen) {
          const chunk = result.slice(i, i + maxLen);
          await ctx.reply(chunk);
        }
      }
    } else if (output.status === 'error') {
      await ctx.reply(`Error: ${output.error}`);
    }
  } catch (err) {
    logger.error({ err }, 'Error processing Telegram message');
    await ctx.reply('Sorry, something went wrong.');
  }
}

export async function startTelegram(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    logger.warn('TELEGRAM_BOT_TOKEN not set, Telegram disabled');
    return;
  }

  if (!TELEGRAM_CONFIG.enabled) {
    logger.info('Telegram channel disabled in config');
    return;
  }

  bot = new Telegraf(token);

  // Handle text messages
  bot.on(message('text'), handleMessage);

  // Handle errors
  bot.catch((err) => {
    logger.error({ err }, 'Telegram bot error');
  });

  // Start bot
  await bot.launch();
  logger.info('Telegram bot started');

  // Graceful shutdown
  process.once('SIGINT', () => bot?.stop('SIGINT'));
  process.once('SIGTERM', () => bot?.stop('SIGTERM'));
}

export function stopTelegram(): void {
  bot?.stop();
}

// Export for registering groups from main channel
export function registerTelegramChat(
  chatId: number,
  name: string,
  folder: string,
  trigger: string
): void {
  const chats = loadTelegramChats();
  chats[`tg:${chatId}`] = {
    name,
    folder,
    trigger,
    added_at: new Date().toISOString()
  };
  saveTelegramChats(chats);

  // Create folder
  const groupDir = path.join(GROUPS_DIR, folder);
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info({ chatId, name, folder }, 'Registered Telegram chat');
}
```

### Step 5: Integrate with Main App

Read `src/index.ts` and add the import at the top:

```typescript
import { startTelegram, stopTelegram } from './telegram.js';
```

Find the section where `startMessageLoop()` is called (in the `connection === 'open'` block) and add:

```typescript
// Start Telegram bot
startTelegram().catch(err => {
  logger.error({ err }, 'Failed to start Telegram bot');
});
```

Find the graceful shutdown handling (if any) and add `stopTelegram()`.

### Step 6: Update Group Memory

Append to `groups/global/CLAUDE.md`:

```markdown

## Telegram

You can also receive messages via Telegram. The experience is the same as WhatsApp - you have access to all your tools and memory.

Telegram-specific notes:
- Messages are limited to 4096 characters (auto-split if longer)
- Markdown formatting is supported
- Private chats don't require the trigger word
```

Also append to `groups/main/CLAUDE.md`:

```markdown

## Telegram Integration

Telegram chats are stored in `data/registered_telegram.json`. Private chats are auto-registered. Groups must be manually registered.

To register a Telegram group, add an entry:
```json
{
  "tg:CHAT_ID": {
    "name": "Group Name",
    "folder": "telegram-group-name",
    "trigger": "@m87",
    "added_at": "ISO_TIMESTAMP"
  }
}
```

Get the chat ID by having someone send a message in the group - check logs for the ID.
```

### Step 7: Create Empty Telegram Registry

```bash
echo '{}' > data/registered_telegram.json
```

### Step 8: Rebuild and Restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Verify it started:

```bash
sleep 2 && tail -20 logs/nanoclaw.log | grep -i telegram
```

### Step 9: Test

Tell the user:

> Telegram bot is running! Test it:
>
> 1. Open Telegram and search for your bot username
> 2. Send `/start` or just say "hello"
> 3. The bot should respond
>
> For groups (if enabled):
> 1. Add the bot to a Telegram group
> 2. Send `@m87 hello` in the group
> 3. Check logs for the chat ID to register it

Monitor logs:

```bash
tail -f logs/nanoclaw.log | grep -i telegram
```

---

## Adding Telegram Groups

After the bot is running, to add a Telegram group:

1. Add the bot to the group
2. Send any message mentioning the bot
3. Check logs: `grep "Telegram message" logs/nanoclaw.log | tail -5`
4. Note the `chatId`
5. Add to `data/registered_telegram.json`:

```json
{
  "tg:-1001234567890": {
    "name": "My Telegram Group",
    "folder": "telegram-my-group",
    "trigger": "@m87",
    "added_at": "2026-02-02T12:00:00.000Z"
  }
}
```

6. Create the folder: `mkdir -p groups/telegram-my-group`

---

## Troubleshooting

### Bot not responding

```bash
# Check if token is set
grep TELEGRAM_BOT_TOKEN .env

# Check logs for errors
tail -50 logs/nanoclaw.log | grep -i telegram
```

### "409 Conflict" error

Another instance is running with the same token. Stop all instances:

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
pkill -f "node.*nanoclaw"
```

Then restart:

```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

### Bot not seeing group messages

1. Talk to @BotFather
2. Send `/setprivacy`
3. Select your bot
4. Choose "Disable"

This lets the bot see all messages, not just commands.

### Message formatting broken

Telegram's Markdown is stricter than WhatsApp. If messages fail to send, the bot retries without formatting.

---

## Removing Telegram Integration

1. Remove from `src/index.ts`:
   - Delete `startTelegram()` import and call

2. Delete `src/telegram.ts`

3. Remove from `.env`:
   - Delete `TELEGRAM_BOT_TOKEN` line

4. Remove Telegram sections from `groups/*/CLAUDE.md`

5. Optionally delete `data/registered_telegram.json`

6. Rebuild:
   ```bash
   npm run build
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw
   ```

7. Optionally delete the bot via @BotFather: `/deletebot`
