import { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import {
  TELEGRAM_CONFIG,
  DATA_DIR,
  GROUPS_DIR,
  ASSISTANT_NAME,
  MAIN_GROUP_FOLDER
} from './config.js';
import { runContainerAgent, writeTasksSnapshot, writeGroupsSnapshot, AvailableGroup } from './container-runner.js';
import { RegisteredGroup } from './types.js';
import { loadJson, saveJson } from './utils.js';
import { getAllTasks } from './db.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

let bot: Telegraf | null = null;
let telegramSessions: Record<string, string> = {};
let getRegisteredGroups: (() => Record<string, RegisteredGroup>) | null = null;
let getSessions: (() => Record<string, string>) | null = null;
let setSessions: ((sessions: Record<string, string>) => void) | null = null;

// Pairing system with admin approval
interface PairedUser {
  userId: number;
  username?: string;
  firstName?: string;
  pairedAt: string;
  approvedBy?: string;
}

interface PendingApproval {
  userId: number;
  username?: string;
  firstName?: string;
  requestedAt: string;
  firstMessage: string;
}

function loadPairedUsers(): Record<number, PairedUser> {
  const filePath = path.join(DATA_DIR, 'telegram_paired_users.json');
  return loadJson(filePath, {});
}

function savePairedUsers(users: Record<number, PairedUser>): void {
  const filePath = path.join(DATA_DIR, 'telegram_paired_users.json');
  saveJson(filePath, users);
}

function loadPendingApprovals(): Record<number, PendingApproval> {
  const filePath = path.join(DATA_DIR, 'telegram_pending_approvals.json');
  return loadJson(filePath, {});
}

function savePendingApprovals(pending: Record<number, PendingApproval>): void {
  const filePath = path.join(DATA_DIR, 'telegram_pending_approvals.json');
  saveJson(filePath, pending);
}

function isUserPaired(userId: number): boolean {
  const users = loadPairedUsers();
  return !!users[userId];
}

function hasPendingApproval(userId: number): boolean {
  const pending = loadPendingApprovals();
  return !!pending[userId];
}

function requestApproval(userId: number, username?: string, firstName?: string, firstMessage?: string): void {
  const pending = loadPendingApprovals();

  // Don't re-request if already pending
  if (pending[userId]) return;

  pending[userId] = {
    userId,
    username,
    firstName,
    requestedAt: new Date().toISOString(),
    firstMessage: firstMessage || ''
  };
  savePendingApprovals(pending);
  logger.info({ userId, username }, 'Telegram access requested');
}

export function approveUser(userId: number, approvedBy?: string): boolean {
  const pending = loadPendingApprovals();
  const pendingUser = pending[userId];

  // Also allow approving users not in pending (direct approval)
  const users = loadPairedUsers();
  users[userId] = {
    userId,
    username: pendingUser?.username,
    firstName: pendingUser?.firstName,
    pairedAt: new Date().toISOString(),
    approvedBy
  };
  savePairedUsers(users);

  // Remove from pending if present
  if (pending[userId]) {
    delete pending[userId];
    savePendingApprovals(pending);
  }

  logger.info({ userId, approvedBy }, 'Telegram user approved');

  // Notify the user via Telegram if bot is running
  if (bot) {
    bot.telegram.sendMessage(userId, `Access approved! You can now chat with me.`).catch(err => {
      logger.debug({ err, userId }, 'Could not notify approved user');
    });
  }

  return true;
}

export function denyUser(userId: number): boolean {
  const pending = loadPendingApprovals();
  if (pending[userId]) {
    delete pending[userId];
    savePendingApprovals(pending);
    logger.info({ userId }, 'Telegram user denied');

    // Notify the user
    if (bot) {
      bot.telegram.sendMessage(userId, `Access denied.`).catch(err => {
        logger.debug({ err, userId }, 'Could not notify denied user');
      });
    }
    return true;
  }
  return false;
}

export function listPendingApprovals(): PendingApproval[] {
  const pending = loadPendingApprovals();
  return Object.values(pending);
}

export function listPairedUsers(): PairedUser[] {
  const users = loadPairedUsers();
  return Object.values(users);
}

export function unpairUser(userId: number): boolean {
  const users = loadPairedUsers();
  if (users[userId]) {
    delete users[userId];
    savePairedUsers(users);
    logger.info({ userId }, 'Telegram user unpaired');
    return true;
  }
  return false;
}

async function notifyAdminOfAccessRequest(
  userId: number,
  username?: string,
  firstName?: string,
  firstMessage?: string
): Promise<void> {
  // Get admin chat ID from environment or use a default admin user
  const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;

  if (!adminChatId) {
    logger.warn('Cannot notify admin: TELEGRAM_ADMIN_CHAT_ID not set');
    return;
  }

  const userDisplay = username ? `@${username}` : firstName || `User ${userId}`;
  const messagePreview = firstMessage
    ? `\n\nFirst message: "${firstMessage.slice(0, 100)}${firstMessage.length > 100 ? '...' : ''}"`
    : '';

  const notification = `*Telegram Access Request*\n\n` +
    `${userDisplay} (ID: ${userId}) wants to access the bot.${messagePreview}\n\n` +
    `Reply:\n` +
    `• "approve telegram ${userId}" to grant access\n` +
    `• "deny telegram ${userId}" to reject`;

  // Send directly via Telegram bot
  if (bot) {
    try {
      await bot.telegram.sendMessage(parseInt(adminChatId, 10), notification, { parse_mode: 'Markdown' });
      logger.info({ userId, username, adminChatId }, 'Admin notified of Telegram access request');
    } catch (err) {
      logger.error({ err, userId }, 'Failed to notify admin of access request');
    }
  }
}

function loadTelegramChats(): Record<string, RegisteredGroup> {
  const filePath = path.join(DATA_DIR, 'registered_telegram.json');
  return loadJson(filePath, {});
}

function saveTelegramChats(chats: Record<string, RegisteredGroup>): void {
  const filePath = path.join(DATA_DIR, 'registered_telegram.json');
  saveJson(filePath, chats);
}

function getGroupFolder(chatId: number, chatType: string, title?: string, username?: string): string {
  const chats = loadTelegramChats();
  const key = `tg:${chatId}`;

  if (chats[key]) {
    return chats[key].folder;
  }

  // Auto-register private chats
  if (chatType === 'private') {
    // For unified main channel, use main folder
    if (TELEGRAM_CONFIG.unifiedMainChannel) {
      return MAIN_GROUP_FOLDER;
    }

    const folder = `telegram-private-${chatId}`;
    const displayName = username || title || `Telegram ${chatId}`;
    chats[key] = {
      name: displayName,
      folder,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString()
    };
    saveTelegramChats(chats);

    // Create folder
    const groupDir = path.join(GROUPS_DIR, folder);
    fs.mkdirSync(groupDir, { recursive: true });

    logger.info({ chatId, folder, name: displayName }, 'Auto-registered Telegram private chat');
    return folder;
  }

  // Auto-register groups when trigger word is used
  if (chatType === 'group' || chatType === 'supergroup') {
    // Create a sanitized folder name from the title
    const safeName = (title || `telegram-group-${chatId}`)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);
    const folder = `telegram-${safeName}`;
    const displayName = title || `Telegram Group ${chatId}`;

    chats[key] = {
      name: displayName,
      folder,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString()
    };
    saveTelegramChats(chats);

    // Create folder
    const groupDir = path.join(GROUPS_DIR, folder);
    fs.mkdirSync(groupDir, { recursive: true });

    logger.info({ chatId, folder, name: displayName }, 'Auto-registered Telegram group');
    return folder;
  }

  return '';
}

async function handleMessage(ctx: Context): Promise<void> {
  if (!ctx.message || !('text' in ctx.message)) return;

  const text = ctx.message.text;
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type;
  const chatTitle = ctx.chat && 'title' in ctx.chat ? ctx.chat.title : undefined;
  const fromUser = ctx.from?.username || ctx.from?.first_name || 'Unknown';
  const fromUsername = ctx.from?.username;

  if (!chatId || !chatType) return;

  logger.info({ chatId, chatType, from: fromUser }, 'Telegram message received');

  const isPrivate = chatType === 'private';
  const userId = ctx.from?.id;
  const firstName = ctx.from?.first_name;

  // Check if user is paired (approved for access)
  if (userId && !isUserPaired(userId)) {
    if (hasPendingApproval(userId)) {
      // Already requested, waiting for approval
      await ctx.reply('Your access request is pending approval. Please wait.');
      return;
    }

    // New user - request approval
    requestApproval(userId, fromUsername, firstName, text);

    // Notify admin via WhatsApp main channel
    await notifyAdminOfAccessRequest(userId, fromUsername, firstName, text);

    await ctx.reply(
      `Welcome! I've sent an access request to the administrator.\n\n` +
      `You'll be notified when your request is approved.`
    );
    return;
  }

  // Check if private chats are enabled
  if (isPrivate && !TELEGRAM_CONFIG.privateChatsEnabled) {
    logger.debug({ chatId }, 'Private chats disabled, ignoring');
    return;
  }

  // Check if groups are enabled
  if (!isPrivate && !TELEGRAM_CONFIG.groupsEnabled) {
    logger.debug({ chatId }, 'Groups disabled, ignoring');
    return;
  }

  // For groups, require trigger pattern (groups will be auto-registered on first trigger)
  if (!isPrivate && !TELEGRAM_CONFIG.triggerPattern.test(text)) {
    logger.debug('Message does not match trigger pattern');
    return;
  }

  // Get folder (auto-registers private chats and groups)
  const folder = getGroupFolder(chatId, chatType, chatTitle, fromUsername);
  const key = `tg:${chatId}`;

  if (!folder) {
    logger.warn({ chatId }, 'No folder for Telegram chat, ignoring');
    return;
  }

  // Remove trigger from message for groups
  const prompt = isPrivate ? text : text.replace(TELEGRAM_CONFIG.triggerPattern, '').trim();

  if (!prompt) return;

  // Send typing indicator
  await ctx.sendChatAction('typing');

  try {
    // Build group config (reload chats to get the freshly registered entry)
    const chats = loadTelegramChats();
    const groupConfig: RegisteredGroup = chats[key] || {
      name: folder,
      folder,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString()
    };

    const isMain = folder === MAIN_GROUP_FOLDER;

    // Get current sessions from main app if available
    const currentSessions = getSessions ? getSessions() : telegramSessions;
    const sessionId = currentSessions[folder];

    // Update tasks snapshot
    const tasks = getAllTasks();
    writeTasksSnapshot(folder, isMain, tasks.map(t => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run
    })));

    // Update available groups snapshot (for main only)
    if (isMain && getRegisteredGroups) {
      const registeredGroups = getRegisteredGroups();
      const availableGroups: AvailableGroup[] = [];  // Would need to pass this from main
      writeGroupsSnapshot(folder, isMain, availableGroups, new Set(Object.keys(registeredGroups)));
    }

    const output = await runContainerAgent(groupConfig, {
      prompt: `<telegram_message from="${fromUser}">${prompt}</telegram_message>`,
      sessionId,
      groupFolder: folder,
      chatJid: key,
      isMain
    });

    if (output.newSessionId) {
      if (setSessions) {
        const sessions = getSessions ? getSessions() : {};
        sessions[folder] = output.newSessionId;
        setSessions(sessions);
      }
      telegramSessions[folder] = output.newSessionId;
    }

    if (output.status === 'success' && output.result) {
      await sendTelegramResponse(ctx, output.result);
    } else if (output.status === 'error') {
      logger.error({ error: output.error }, 'Container agent error');
      await ctx.reply(`Error: ${output.error}`);
    }
  } catch (err) {
    logger.error({ err }, 'Error processing Telegram message');
    await ctx.reply('Sorry, something went wrong.');
  }
}

async function sendTelegramResponse(ctx: Context, text: string): Promise<void> {
  const maxLen = 4000;

  // No prefix needed - Telegram bot has its own identity
  if (text.length <= maxLen) {
    try {
      await ctx.reply(text, { parse_mode: 'Markdown' });
    } catch {
      // Retry without markdown if it fails
      await ctx.reply(text);
    }
  } else {
    // Split into chunks
    for (let i = 0; i < text.length; i += maxLen) {
      const chunk = text.slice(i, i + maxLen);
      await ctx.reply(chunk);
    }
  }
}

let telegramStarted = false;

export async function startTelegram(options?: {
  getRegisteredGroups?: () => Record<string, RegisteredGroup>;
  getSessions?: () => Record<string, string>;
  setSessions?: (sessions: Record<string, string>) => void;
}): Promise<void> {
  logger.info('startTelegram called');

  // Prevent multiple starts
  if (telegramStarted) {
    logger.debug('Telegram already started, skipping');
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  logger.info({ hasToken: !!token, configEnabled: TELEGRAM_CONFIG.enabled }, 'Telegram config check');

  if (!token) {
    logger.error('TELEGRAM_BOT_TOKEN not set - cannot start');
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }

  if (!TELEGRAM_CONFIG.enabled) {
    logger.info('Telegram channel disabled in config');
    return;
  }

  logger.info('Initializing Telegraf bot...');

  // Store callbacks for integration with main app
  if (options) {
    getRegisteredGroups = options.getRegisteredGroups || null;
    getSessions = options.getSessions || null;
    setSessions = options.setSessions || null;
  }

  bot = new Telegraf(token);

  // Handle text messages
  bot.on(message('text'), handleMessage);

  // Handle errors
  bot.catch((err) => {
    logger.error({ err }, 'Telegram bot error');
  });

  // Start bot (don't await - launch() runs indefinitely)
  logger.info('Launching Telegram bot...');
  bot.launch()
    .then(() => {
      // This only runs when bot is stopped
      logger.info('Telegram bot stopped');
      telegramStarted = false;
    })
    .catch((err) => {
      logger.error({ err }, 'Failed to start Telegram bot');
      telegramStarted = false;
    });

  // Give the bot a moment to connect, then mark as started
  await new Promise(resolve => setTimeout(resolve, 2000));
  telegramStarted = true;
  logger.info('Telegram bot started');

  // Graceful shutdown
  process.once('SIGINT', () => bot?.stop('SIGINT'));
  process.once('SIGTERM', () => bot?.stop('SIGTERM'));
}

export function stopTelegram(): void {
  if (bot) {
    bot.stop();
    logger.info('Telegram bot stopped');
  }
}

/**
 * Send a message to a Telegram chat.
 * Used by IPC handler to route messages to Telegram instead of WhatsApp.
 */
export async function sendTelegramMessage(chatId: number, text: string): Promise<boolean> {
  if (!bot) {
    logger.warn({ chatId }, 'Cannot send Telegram message: bot not started');
    return false;
  }

  try {
    // Telegram has a 4096 char limit
    const maxLen = 4000;
    if (text.length <= maxLen) {
      try {
        await bot.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown' });
      } catch {
        // Retry without markdown if it fails
        await bot.telegram.sendMessage(chatId, text);
      }
    } else {
      // Split into chunks
      for (let i = 0; i < text.length; i += maxLen) {
        const chunk = text.slice(i, i + maxLen);
        await bot.telegram.sendMessage(chatId, chunk);
      }
    }
    logger.info({ chatId, length: text.length }, 'Telegram message sent');
    return true;
  } catch (err) {
    logger.error({ chatId, err }, 'Failed to send Telegram message');
    return false;
  }
}

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
