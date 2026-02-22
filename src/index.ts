import 'dotenv/config';
import pino from 'pino';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  MAIN_GROUP_FOLDER,
  IPC_POLL_INTERVAL,
  TIMEZONE
} from './config.js';
import { RegisteredGroup, Session } from './types.js';
import { initDatabase, getAllTasks, getTaskById, updateTask, createTask, deleteTask } from './db.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { writeTasksSnapshot, writeGroupsSnapshot, writeTelegramPendingSnapshot } from './container-runner.js';
import { loadJson, saveJson } from './utils.js';
import { startTelegram, sendTelegramMessage } from './telegram.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

let sessions: Session = {};
let registeredGroups: Record<string, RegisteredGroup> = {};

function loadState(): void {
  sessions = loadJson(path.join(DATA_DIR, 'sessions.json'), {});
  registeredGroups = loadJson(path.join(DATA_DIR, 'registered_groups.json'), {});
  logger.info({ groupCount: Object.keys(registeredGroups).length }, 'State loaded');
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  saveJson(path.join(DATA_DIR, 'registered_groups.json'), registeredGroups);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info({ jid, name: group.name, folder: group.folder }, 'Group registered');
}

function startIpcWatcher(): void {
  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter(f => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs.readdirSync(messagesDir).filter(f => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // All messages go to Telegram now
                if (data.chatJid.startsWith('tg:')) {
                  if (isMain) {
                    const chatId = parseInt(data.chatJid.replace('tg:', ''), 10);
                    if (!isNaN(chatId)) {
                      await sendTelegramMessage(chatId, `${ASSISTANT_NAME}: ${data.text}`);
                      logger.info({ chatJid: data.chatJid, sourceGroup }, 'IPC Telegram message sent');
                    } else {
                      logger.warn({ chatJid: data.chatJid }, 'Invalid Telegram chat ID');
                    }
                  } else {
                    logger.warn({ chatJid: data.chatJid, sourceGroup }, 'Unauthorized Telegram IPC message attempt blocked');
                  }
                } else {
                  logger.warn({ chatJid: data.chatJid }, 'Non-Telegram JID - WhatsApp removed');
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error({ file, sourceGroup, err }, 'Error processing IPC message');
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC messages directory');
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs.readdirSync(tasksDir).filter(f => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              await processTaskIpc(data, sourceGroup, isMain);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error({ file, sourceGroup, err }, 'Error processing IPC task');
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For telegram approval
    userId?: number | string;
  },
  sourceGroup: string,
  isMain: boolean
): Promise<void> {
  const { CronExpressionParser } = await import('cron-parser');

  switch (data.type) {
    case 'schedule_task':
      if (data.prompt && data.schedule_type && data.schedule_value && data.groupFolder) {
        const targetGroup = data.groupFolder;
        if (!isMain && targetGroup !== sourceGroup) {
          logger.warn({ sourceGroup, targetGroup }, 'Unauthorized schedule_task attempt blocked');
          break;
        }

        // For Telegram-only, use the chatJid directly
        const targetJid = data.chatJid || Object.entries(registeredGroups).find(
          ([, group]) => group.folder === targetGroup
        )?.[0];

        if (!targetJid) {
          logger.warn({ targetGroup }, 'Cannot schedule task: no JID available');
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, { tz: TIMEZONE });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn({ scheduleValue: data.schedule_value }, 'Invalid cron expression');
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn({ scheduleValue: data.schedule_value }, 'Invalid interval');
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn({ scheduleValue: data.schedule_value }, 'Invalid timestamp');
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode = (data.context_mode === 'group' || data.context_mode === 'isolated')
          ? data.context_mode
          : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetGroup,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString()
        });
        logger.info({ taskId, sourceGroup, targetGroup, contextMode }, 'Task created via IPC');
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task paused via IPC');
        } else {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task pause attempt');
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task resumed via IPC');
        } else {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task resume attempt');
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task cancelled via IPC');
        } else {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task cancel attempt');
        }
      }
      break;

    case 'register_group':
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized register_group attempt blocked');
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig
        });
      } else {
        logger.warn({ data }, 'Invalid register_group request - missing required fields');
      }
      break;

    case 'telegram_approve':
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized telegram_approve attempt blocked');
        break;
      }
      if (data.userId) {
        const { approveUser } = await import('./telegram.js');
        approveUser(Number(data.userId), 'main');
        logger.info({ userId: data.userId }, 'Telegram user approved via IPC');
      }
      break;

    case 'telegram_deny':
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized telegram_deny attempt blocked');
        break;
      }
      if (data.userId) {
        const { denyUser } = await import('./telegram.js');
        denyUser(Number(data.userId));
        logger.info({ userId: data.userId }, 'Telegram user denied via IPC');
      }
      break;

    case 'telegram_list_pending':
      if (!isMain) {
        break;
      }
      const { listPendingApprovals } = await import('./telegram.js');
      const pending = listPendingApprovals();
      logger.info({ pending }, 'Telegram pending approvals');
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

function ensureContainerSystemRunning(): void {
  try {
    execSync('container system status', { stdio: 'pipe' });
    logger.debug('Apple Container system already running');
  } catch {
    logger.info('Starting Apple Container system...');
    try {
      execSync('container system start', { stdio: 'pipe', timeout: 30000 });
      logger.info('Apple Container system started');
    } catch (err) {
      logger.error({ err }, 'Failed to start Apple Container system');
      console.error('\n╔════════════════════════════════════════════════════════════════╗');
      console.error('║  FATAL: Apple Container system failed to start                 ║');
      console.error('║                                                                ║');
      console.error('║  Agents cannot run without Apple Container. To fix:           ║');
      console.error('║  1. Install from: https://github.com/apple/container/releases ║');
      console.error('║  2. Run: container system start                               ║');
      console.error('║  3. Restart NanoClaw                                          ║');
      console.error('╚════════════════════════════════════════════════════════════════╝\n');
      throw new Error('Apple Container system is required but failed to start');
    }
  }
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Start IPC watcher
  startIpcWatcher();

  // Start scheduler
  startSchedulerLoop({
    sendMessage: async (jid: string, text: string) => {
      // All scheduled task messages go to Telegram
      if (jid.startsWith('tg:')) {
        const chatId = parseInt(jid.replace('tg:', ''), 10);
        if (!isNaN(chatId)) {
          await sendTelegramMessage(chatId, text);
        }
      } else {
        logger.warn({ jid }, 'Non-Telegram JID in scheduler - WhatsApp removed');
      }
    },
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions
  });

  // Start Telegram bot (primary channel)
  try {
    await startTelegram({
      getRegisteredGroups: () => registeredGroups,
      getSessions: () => sessions,
      setSessions: (newSessions) => {
        sessions = { ...sessions, ...newSessions };
        saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
      }
    });
    logger.info(`NanoClaw running (Telegram-only, trigger: @${ASSISTANT_NAME})`);
  } catch (err) {
    logger.error({ err }, 'Failed to start Telegram bot');
    process.exit(1);
  }

  // Keep the process alive
  process.on('SIGINT', () => {
    logger.info('Shutting down...');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.info('Shutting down...');
    process.exit(0);
  });
}

main().catch(err => {
  logger.error({ err }, 'Failed to start NanoClaw');
  process.exit(1);
});
