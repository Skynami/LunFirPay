/**
 * Telegram 通知服务（完整模块）
 * 
 * 包含：
 * - Bot 配置加载
 * - Bot 命令处理
 * - 消息发送服务
 * - API 路由（绑定管理）
 * 
 * 设计说明：
 * 1. 一个用户（商户/服务商/RAM）只能绑定一个 Telegram 账号
 * 2. 商户下任意 PID 交易成功都会通知到商户
 * 3. 商户 RAM 如果有权限，也会收到通知
 * 4. 服务商发起结算时，通知到相关商户
 * 5. 自动结算单生成时，通知服务商
 * 6. 订单状态区分：已完成 / 已支付未回调
 */
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const mysql = require('mysql2/promise');
const { config: dbConfig } = require('../config/database');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// ==================== 配置加载 ====================

// 加载 config.yaml（必须存在）
const configPath = path.join(__dirname, '..', 'config.yaml');
if (!fs.existsSync(configPath)) {
  throw new Error('[Telegram] 配置文件 config.yaml 不存在，请创建配置文件');
}
const mainConfig = yaml.load(fs.readFileSync(configPath, 'utf8'));
const telegramConfig = mainConfig.telegram || {};

// 引入系统配置服务
const systemConfig = require('../utils/systemConfig');

// 配置对象
const config = {
  // 机器人 Token（优先使用环境变量）
  botToken: process.env.TELEGRAM_BOT_TOKEN || telegramConfig.botToken || '',
  // 机器人用户名（用于生成绑定链接）
  botName: process.env.TELEGRAM_BOT_NAME || telegramConfig.botName || 'epay_notify_bot'
};

// 数据库连接池
const db = mysql.createPool({
  ...dbConfig,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000
});

// Bot 实例
let bot = null;
let isRunning = false;

// 消息队列
const messageQueue = [];
let isProcessing = false;

// ==================== Bot 初始化与命令处理 ====================

/**
 * 初始化并启动 Telegram Bot
 */
async function start() {
  if (isRunning) {
    console.log('[Telegram] Bot 已在运行');
    return true;
  }
  
  try {
    // 如果没有配置 Token，跳过启动
    if (!config.botToken) {
      console.log('[Telegram] 未配置 Bot Token，跳过启动');
      return false;
    }
    
    bot = new TelegramBot(config.botToken, { polling: true });
    
    // 设置命令菜单
    await bot.setMyCommands([
      { command: 'start', description: '开始使用' },
      { command: 'bind', description: '绑定账号（输入绑定码）' },
      { command: 'help', description: '查看帮助' },
      { command: 'status', description: '查看绑定状态' },
      { command: 'balance', description: '查询账户余额' },
      { command: 'settings', description: '通知设置' },
      { command: 'unbind', description: '解除账号绑定' }
    ]);
    
    // 设置命令处理器
    setupCommandHandlers();
    
    // 设置回调处理器
    setupCallbackHandler();
    
    isRunning = true;
    console.log('[Telegram] Bot 已启动');
    return true;
  } catch (error) {
    console.error('[Telegram] 启动失败:', error.message);
    return false;
  }
}

/**
 * 停止 Telegram Bot
 */
function stop() {
  if (bot) {
    bot.stopPolling();
    bot = null;
    isRunning = false;
    console.log('[Telegram] Bot 已停止');
  }
}

/**
 * 设置命令处理器
 */
function setupCommandHandlers() {
  if (!bot) return;
  
  // /start 命令 - 开始使用或绑定账号
  bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const token = match[1];
    
    if (token) {
      await handleBind(chatId, token, msg.from);
    } else {
      await handleStart(chatId, msg.from);
    }
  });
  
  // /bind 命令 - 手动输入绑定码
  bot.onText(/\/bind(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const token = match[1]?.trim();
    
    if (token) {
      await handleBind(chatId, token, msg.from);
    } else {
      await bot.sendMessage(chatId, `
ℹ️ *绑定说明*

请在平台获取绑定码后，使用以下格式绑定：

\`/bind 您的绑定码\`

例如：\`/bind abc123def456\`

💡 绑定码可在平台「个人设置」中点击「绑定 Telegram」获取
`.trim(), { parse_mode: 'Markdown' });
    }
  });
  
  // /help 命令
  bot.onText(/\/help/, async (msg) => {
    await handleHelp(msg.chat.id);
  });
  
  // /unbind 命令
  bot.onText(/\/unbind/, async (msg) => {
    await handleUnbind(msg.chat.id, msg.from);
  });
  
  // /status 命令
  bot.onText(/\/status/, async (msg) => {
    await handleStatus(msg.chat.id, msg.from);
  });
  
  // /balance 命令
  bot.onText(/\/balance/, async (msg) => {
    await handleBalance(msg.chat.id, msg.from);
  });
  
  // /settings 命令
  bot.onText(/\/settings/, async (msg) => {
    await handleSettings(msg.chat.id, msg.from);
  });
}

/**
 * 处理 /start 命令
 */
async function handleStart(chatId, fromUser) {
  const siteName = await systemConfig.getSiteName();
  
  const welcome = `
👋 欢迎使用 *${siteName}* 通知机器人！

📌 *主要功能*
• 实时接收收款通知
• 查询账户余额
• 结算状态提醒

🔗 *如何绑定*
请在 ${siteName} 平台的「个人设置」中点击「绑定 Telegram」获取绑定链接

📋 *可用命令*
/status - 查看绑定状态
/balance - 查询账户余额
/settings - 通知设置
/unbind - 解除绑定
/help - 查看帮助
`.trim();
  
  await bot.sendMessage(chatId, welcome, { parse_mode: 'Markdown' });
}

/**
 * 处理 /help 命令
 */
async function handleHelp(chatId) {
  const helpText = `
📖 *命令帮助*

/start - 开始使用
/status - 查看当前绑定状态
/balance - 查询账户余额
/settings - 设置通知偏好
/unbind - 解除账号绑定

💡 *通知类型*
• 收款通知：订单支付成功
• 余额变动：资金变动提醒
• 结算通知：结算状态更新

⚙️ *通知设置*
使用 /settings 命令可以：
• 开关各类型通知
• 设置单个 PID 的通知

🔐 *安全提示*
• 请勿将绑定链接分享给他人
• 如有问题请联系客服
`.trim();
  
  await bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
}

/**
 * 处理绑定请求
 */
async function handleBind(chatId, token, fromUser) {
  try {
    const [tokenInfo] = await db.query(
      `SELECT * FROM telegram_bind_tokens 
       WHERE token = ? AND expires_at > NOW()`,
      [token]
    );
    
    if (tokenInfo.length === 0) {
      await bot.sendMessage(chatId, '❌ 绑定链接无效或已过期，请重新获取');
      return;
    }
    
    const { user_id, user_type } = tokenInfo[0];
    const telegramId = fromUser.id.toString();
    const username = fromUser.username || '';
    const nickname = [fromUser.first_name, fromUser.last_name].filter(Boolean).join(' ') || '';
    
    // 删除或更新旧绑定
    await db.query(
      'DELETE FROM telegram_bindings WHERE user_id = ? AND user_type = ?',
      [user_id, user_type]
    );
    
    // 创建新绑定
    await db.query(
      `INSERT INTO telegram_bindings 
       (user_id, user_type, telegram_id, username, nickname, chat_id, enabled, 
        notify_payment, notify_balance, notify_settlement)
       VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1, 1)`,
      [user_id, user_type, telegramId, username, nickname, chatId]
    );
    
    // 删除已使用的 token
    await db.query('DELETE FROM telegram_bind_tokens WHERE id = ?', [tokenInfo[0].id]);
    
    const typeNames = {
      merchant: '商户',
      admin: '管理员',
      ram: 'RAM子账户'
    };
    
    await bot.sendMessage(chatId, `
✅ *绑定成功！*

账户类型：${typeNames[user_type] || user_type}
用户ID：\`${user_id}\`

您将收到以下通知：
• 💰 收款通知（含订单状态）
• 💳 余额变动
• ✅ 结算通知

使用 /status 查看绑定状态
使用 /unbind 解除绑定
`.trim(), { parse_mode: 'Markdown' });
    
  } catch (error) {
    console.error('[Telegram] 绑定失败:', error);
    await bot.sendMessage(chatId, '❌ 绑定失败，请稍后重试');
  }
}

/**
 * 处理解绑命令
 */
async function handleUnbind(chatId, fromUser) {
  try {
    const telegramId = fromUser.id.toString();
    
    const [bindings] = await db.query(
      'SELECT * FROM telegram_bindings WHERE telegram_id = ?',
      [telegramId]
    );
    
    if (bindings.length === 0) {
      await bot.sendMessage(chatId, '您当前没有绑定任何账户');
      return;
    }
    
    if (bindings.length > 1) {
      const keyboard = bindings.map(b => [{
        text: `解绑 ${b.user_type === 'merchant' ? '商户' : b.user_type === 'admin' ? '管理员' : 'RAM'} (${b.user_id})`,
        callback_data: `unbind_${b.id}`
      }]);
      keyboard.push([{ text: '解绑全部', callback_data: 'unbind_all' }]);
      keyboard.push([{ text: '取消', callback_data: 'cancel' }]);
      
      await bot.sendMessage(chatId, '请选择要解绑的账户：', {
        reply_markup: { inline_keyboard: keyboard }
      });
    } else {
      await db.query('DELETE FROM telegram_bindings WHERE telegram_id = ?', [telegramId]);
      await bot.sendMessage(chatId, '✅ 已成功解除绑定');
    }
  } catch (error) {
    console.error('[Telegram] 解绑失败:', error);
    await bot.sendMessage(chatId, '❌ 解绑失败，请稍后重试');
  }
}

/**
 * 处理状态查询
 */
async function handleStatus(chatId, fromUser) {
  try {
    const telegramId = fromUser.id.toString();
    
    const [bindings] = await db.query(
      'SELECT * FROM telegram_bindings WHERE telegram_id = ?',
      [telegramId]
    );
    
    if (bindings.length === 0) {
      await bot.sendMessage(chatId, '您当前没有绑定任何账户\n\n请在 LunaFir 平台的个人设置中获取绑定链接');
      return;
    }
    
    let statusText = '📋 *绑定状态*\n\n';
    
    for (const b of bindings) {
      const typeName = b.user_type === 'merchant' ? '商户' : b.user_type === 'admin' ? '管理员' : 'RAM子账户';
      statusText += `*${typeName}*\n`;
      statusText += `用户ID：\`${b.user_id}\`\n`;
      statusText += `状态：${b.enabled ? '✅ 已启用' : '❌ 已禁用'}\n`;
      statusText += `通知设置：\n`;
      statusText += `  • 收款通知：${b.notify_payment ? '✅' : '❌'}\n`;
      statusText += `  • 余额变动：${b.notify_balance ? '✅' : '❌'}\n`;
      statusText += `  • 结算通知：${b.notify_settlement ? '✅' : '❌'}\n`;
      statusText += `绑定时间：${new Date(b.created_at).toLocaleString('zh-CN')}\n\n`;
    }
    
    await bot.sendMessage(chatId, statusText, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('[Telegram] 查询状态失败:', error);
    await bot.sendMessage(chatId, '❌ 查询失败，请稍后重试');
  }
}

/**
 * 处理余额查询
 */
async function handleBalance(chatId, fromUser) {
  try {
    const telegramId = fromUser.id.toString();
    
    const [bindings] = await db.query(
      'SELECT * FROM telegram_bindings WHERE telegram_id = ?',
      [telegramId]
    );
    
    if (bindings.length === 0) {
      await bot.sendMessage(chatId, '您当前没有绑定任何账户');
      return;
    }
    
    let balanceText = '💰 *余额查询*\n\n';
    
    for (const b of bindings) {
      const typeName = b.user_type === 'merchant' ? '商户' : b.user_type === 'admin' ? '管理员' : 'RAM';
      let balance = 0;
      let frozenBalance = 0;
      
      if (b.user_type === 'merchant') {
        const [rows] = await db.query(
          'SELECT balance FROM merchants WHERE user_id = ?',
          [b.user_id]
        );
        balance = rows[0]?.balance || 0;
        frozenBalance = 0;
      } else if (b.user_type === 'admin') {
        // 管理员：显示平台总收入统计
        const [[stats]] = await db.query(
          'SELECT COALESCE(SUM(fee_money), 0) as total_fee FROM orders WHERE status = 1'
        );
        balance = stats?.total_fee || 0;
        frozenBalance = 0;
      } else if (b.user_type === 'ram') {
        const [ramInfo] = await db.query(
          'SELECT owner_id FROM user_ram WHERE user_id = ?',
          [b.user_id]
        );
        if (ramInfo.length > 0) {
          const [rows] = await db.query(
            'SELECT balance FROM merchants WHERE user_id = ?',
            [ramInfo[0].owner_id]
          );
          balance = rows[0]?.balance || 0;
          frozenBalance = 0;
        }
      }
      
      balanceText += `*${typeName}* (${b.user_id})\n`;
      if (b.user_type === 'admin') {
        balanceText += `平台总手续费：¥${parseFloat(balance).toFixed(2)}\n\n`;
      } else {
        balanceText += `可用余额：¥${parseFloat(balance).toFixed(2)}\n\n`;
      }
    }
    
    await bot.sendMessage(chatId, balanceText, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('[Telegram] 查询余额失败:', error);
    await bot.sendMessage(chatId, '❌ 查询失败，请稍后重试');
  }
}

/**
 * 处理通知设置
 */
async function handleSettings(chatId, fromUser) {
  try {
    const telegramId = fromUser.id.toString();
    
    const [bindings] = await db.query(
      'SELECT * FROM telegram_bindings WHERE telegram_id = ?',
      [telegramId]
    );
    
    if (bindings.length === 0) {
      await bot.sendMessage(chatId, '您当前没有绑定任何账户');
      return;
    }
    
    if (bindings.length === 1) {
      await showBindingSettings(chatId, bindings[0]);
    } else {
      const keyboard = bindings.map(b => [{
        text: `⚙️ ${b.user_type === 'merchant' ? '商户' : b.user_type === 'admin' ? '管理员' : 'RAM'} (${b.user_id})`,
        callback_data: `settings_${b.id}`
      }]);
      keyboard.push([{ text: '❌ 取消', callback_data: 'cancel' }]);
      
      await bot.sendMessage(chatId, '请选择要配置的账户：', {
        reply_markup: { inline_keyboard: keyboard }
      });
    }
  } catch (error) {
    console.error('[Telegram] 设置失败:', error);
    await bot.sendMessage(chatId, '❌ 操作失败，请稍后重试');
  }
}

/**
 * 显示单个绑定的设置界面
 */
async function showBindingSettings(chatId, binding, messageId = null) {
  const typeName = binding.user_type === 'merchant' ? '商户' : binding.user_type === 'admin' ? '管理员' : 'RAM子账户';
  
  const text = `
⚙️ *通知设置*

账户类型：${typeName}
用户ID：\`${binding.user_id}\`

点击下方按钮开关对应通知：
`.trim();
  
  const keyboard = [
    [{ 
      text: `${binding.enabled ? '✅' : '❌'} 总开关（${binding.enabled ? '已启用' : '已禁用'}）`, 
      callback_data: `toggle_enabled_${binding.id}` 
    }],
    [{ 
      text: `${binding.notify_payment ? '✅' : '❌'} 收款通知`, 
      callback_data: `toggle_payment_${binding.id}` 
    }],
    [{ 
      text: `${binding.notify_balance ? '✅' : '❌'} 余额变动`, 
      callback_data: `toggle_balance_${binding.id}` 
    }],
    [{ 
      text: `${binding.notify_settlement ? '✅' : '❌'} 结算通知`, 
      callback_data: `toggle_settlement_${binding.id}` 
    }],
    [
      { text: '🔕 全部关闭', callback_data: `all_off_${binding.id}` },
      { text: '🔔 全部开启', callback_data: `all_on_${binding.id}` }
    ]
  ];
  
  if (binding.user_type === 'merchant') {
    keyboard.push([{ text: '🏪 PID通知设置', callback_data: `pid_settings_${binding.id}` }]);
  }
  
  keyboard.push([{ text: '❌ 关闭', callback_data: 'cancel' }]);
  
  const options = {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  };
  
  if (messageId) {
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
  } else {
    await bot.sendMessage(chatId, text, options);
  }
}

/**
 * 设置回调处理器（按钮点击）
 */
function setupCallbackHandler() {
  if (!bot) return;
  
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;
    const telegramId = query.from.id.toString();
    
    try {
      if (data === 'cancel') {
        await bot.deleteMessage(chatId, messageId);
        await bot.answerCallbackQuery(query.id);
        return;
      }
      
      if (data === 'unbind_all') {
        await db.query('DELETE FROM telegram_bindings WHERE telegram_id = ?', [telegramId]);
        await bot.editMessageText('✅ 已成功解除所有绑定', { chat_id: chatId, message_id: messageId });
        await bot.answerCallbackQuery(query.id, { text: '已解除所有绑定' });
        return;
      }
      
      if (data.startsWith('unbind_')) {
        const bindingId = data.replace('unbind_', '');
        await db.query('DELETE FROM telegram_bindings WHERE id = ? AND telegram_id = ?', [bindingId, telegramId]);
        await bot.editMessageText('✅ 已成功解除绑定', { chat_id: chatId, message_id: messageId });
        await bot.answerCallbackQuery(query.id, { text: '已解除绑定' });
        return;
      }
      
      if (data.startsWith('settings_')) {
        const bindingId = data.replace('settings_', '');
        const [bindings] = await db.query('SELECT * FROM telegram_bindings WHERE id = ? AND telegram_id = ?', [bindingId, telegramId]);
        if (bindings.length > 0) {
          await showBindingSettings(chatId, bindings[0], messageId);
        }
        await bot.answerCallbackQuery(query.id);
        return;
      }
      
      if (data.startsWith('toggle_enabled_')) {
        const bindingId = data.replace('toggle_enabled_', '');
        await db.query('UPDATE telegram_bindings SET enabled = NOT enabled WHERE id = ? AND telegram_id = ?', [bindingId, telegramId]);
        const [bindings] = await db.query('SELECT * FROM telegram_bindings WHERE id = ?', [bindingId]);
        if (bindings.length > 0) {
          await showBindingSettings(chatId, bindings[0], messageId);
          await bot.answerCallbackQuery(query.id, { text: bindings[0].enabled ? '✅ 已启用通知' : '❌ 已禁用通知' });
        }
        return;
      }
      
      if (data.startsWith('toggle_payment_')) {
        const bindingId = data.replace('toggle_payment_', '');
        await db.query('UPDATE telegram_bindings SET notify_payment = NOT notify_payment WHERE id = ? AND telegram_id = ?', [bindingId, telegramId]);
        const [bindings] = await db.query('SELECT * FROM telegram_bindings WHERE id = ?', [bindingId]);
        if (bindings.length > 0) {
          await showBindingSettings(chatId, bindings[0], messageId);
          await bot.answerCallbackQuery(query.id, { text: bindings[0].notify_payment ? '✅ 收款通知已开启' : '❌ 收款通知已关闭' });
        }
        return;
      }
      
      if (data.startsWith('toggle_balance_')) {
        const bindingId = data.replace('toggle_balance_', '');
        await db.query('UPDATE telegram_bindings SET notify_balance = NOT notify_balance WHERE id = ? AND telegram_id = ?', [bindingId, telegramId]);
        const [bindings] = await db.query('SELECT * FROM telegram_bindings WHERE id = ?', [bindingId]);
        if (bindings.length > 0) {
          await showBindingSettings(chatId, bindings[0], messageId);
          await bot.answerCallbackQuery(query.id, { text: bindings[0].notify_balance ? '✅ 余额通知已开启' : '❌ 余额通知已关闭' });
        }
        return;
      }
      
      if (data.startsWith('toggle_settlement_')) {
        const bindingId = data.replace('toggle_settlement_', '');
        await db.query('UPDATE telegram_bindings SET notify_settlement = NOT notify_settlement WHERE id = ? AND telegram_id = ?', [bindingId, telegramId]);
        const [bindings] = await db.query('SELECT * FROM telegram_bindings WHERE id = ?', [bindingId]);
        if (bindings.length > 0) {
          await showBindingSettings(chatId, bindings[0], messageId);
          await bot.answerCallbackQuery(query.id, { text: bindings[0].notify_settlement ? '✅ 结算通知已开启' : '❌ 结算通知已关闭' });
        }
        return;
      }
      
      if (data.startsWith('all_off_')) {
        const bindingId = data.replace('all_off_', '');
        await db.query('UPDATE telegram_bindings SET notify_payment = 0, notify_balance = 0, notify_settlement = 0 WHERE id = ? AND telegram_id = ?', [bindingId, telegramId]);
        const [bindings] = await db.query('SELECT * FROM telegram_bindings WHERE id = ?', [bindingId]);
        if (bindings.length > 0) {
          await showBindingSettings(chatId, bindings[0], messageId);
          await bot.answerCallbackQuery(query.id, { text: '🔕 已关闭所有通知' });
        }
        return;
      }
      
      if (data.startsWith('all_on_')) {
        const bindingId = data.replace('all_on_', '');
        await db.query('UPDATE telegram_bindings SET notify_payment = 1, notify_balance = 1, notify_settlement = 1 WHERE id = ? AND telegram_id = ?', [bindingId, telegramId]);
        const [bindings] = await db.query('SELECT * FROM telegram_bindings WHERE id = ?', [bindingId]);
        if (bindings.length > 0) {
          await showBindingSettings(chatId, bindings[0], messageId);
          await bot.answerCallbackQuery(query.id, { text: '🔔 已开启所有通知' });
        }
        return;
      }
      
      if (data.startsWith('pid_settings_')) {
        const bindingId = data.replace('pid_settings_', '');
        await showPidSettings(chatId, bindingId, telegramId, messageId);
        await bot.answerCallbackQuery(query.id);
        return;
      }
      
      if (data.startsWith('toggle_pid_')) {
        const parts = data.replace('toggle_pid_', '').split('_');
        const bindingId = parts[0];
        const pid = parts.slice(1).join('_');
        await togglePidSetting(bindingId, pid, telegramId);
        await showPidSettings(chatId, bindingId, telegramId, messageId);
        await bot.answerCallbackQuery(query.id, { text: 'PID 设置已更新' });
        return;
      }
      
      if (data.startsWith('pid_all_on_')) {
        const bindingId = data.replace('pid_all_on_', '');
        await db.query('UPDATE telegram_pid_settings SET enabled = 1 WHERE binding_id = ?', [bindingId]);
        await showPidSettings(chatId, bindingId, telegramId, messageId);
        await bot.answerCallbackQuery(query.id, { text: '🔔 已开启所有 PID 通知' });
        return;
      }
      
      if (data.startsWith('pid_all_off_')) {
        const bindingId = data.replace('pid_all_off_', '');
        await db.query('UPDATE telegram_pid_settings SET enabled = 0 WHERE binding_id = ?', [bindingId]);
        await showPidSettings(chatId, bindingId, telegramId, messageId);
        await bot.answerCallbackQuery(query.id, { text: '🔕 已关闭所有 PID 通知' });
        return;
      }
      
      if (data.startsWith('back_settings_')) {
        const bindingId = data.replace('back_settings_', '');
        const [bindings] = await db.query('SELECT * FROM telegram_bindings WHERE id = ?', [bindingId]);
        if (bindings.length > 0) {
          await showBindingSettings(chatId, bindings[0], messageId);
        }
        await bot.answerCallbackQuery(query.id);
        return;
      }
      
      await bot.answerCallbackQuery(query.id);
    } catch (error) {
      console.error('[Telegram] 处理回调失败:', error);
      await bot.answerCallbackQuery(query.id, { text: '操作失败，请重试' });
    }
  });
}

/**
 * 显示 PID 设置界面
 */
async function showPidSettings(chatId, bindingId, telegramId, messageId = null) {
  try {
    const [bindings] = await db.query(
      'SELECT * FROM telegram_bindings WHERE id = ? AND telegram_id = ?',
      [bindingId, telegramId]
    );
    
    if (bindings.length === 0) {
      await bot.sendMessage(chatId, '❌ 绑定不存在');
      return;
    }
    
    const binding = bindings[0];
    
    // 查询商户的 PID（API使用的12位随机ID）
    const [pids] = await db.query(
      `SELECT m.pid, m.status 
       FROM merchants m 
       WHERE m.user_id = ? AND m.status = 'active'
       ORDER BY m.pid`,
      [binding.user_id]
    );
    
    if (pids.length === 0) {
      const text = `🏪 *PID 通知设置*\n\n该账户下暂无已审核的 PID`;
      const keyboard = [[{ text: '◀️ 返回', callback_data: `back_settings_${bindingId}` }]];
      
      if (messageId) {
        await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
      } else {
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
      }
      return;
    }
    
    const [pidSettings] = await db.query('SELECT pid, enabled FROM telegram_pid_settings WHERE binding_id = ?', [bindingId]);
    const pidSettingsMap = {};
    for (const ps of pidSettings) {
      pidSettingsMap[ps.pid] = ps.enabled === 1;
    }
    
    for (const p of pids) {
      if (!(p.pid in pidSettingsMap)) {
        await db.query('INSERT INTO telegram_pid_settings (binding_id, pid, enabled) VALUES (?, ?, 1)', [bindingId, p.pid]);
        pidSettingsMap[p.pid] = true;
      }
    }
    
    const text = `🏪 *PID 通知设置*\n\n共 ${pids.length} 个 PID，点击切换通知开关：`;
    
    const keyboard = [];
    for (let i = 0; i < pids.length; i += 2) {
      const row = [];
      for (let j = i; j < Math.min(i + 2, pids.length); j++) {
        const p = pids[j];
        const enabled = pidSettingsMap[p.pid] !== false;
        row.push({ text: `${enabled ? '✅' : '❌'} ${p.pid}`, callback_data: `toggle_pid_${bindingId}_${p.pid}` });
      }
      keyboard.push(row);
    }
    
    keyboard.push([
      { text: '🔕 全部关闭', callback_data: `pid_all_off_${bindingId}` },
      { text: '🔔 全部开启', callback_data: `pid_all_on_${bindingId}` }
    ]);
    keyboard.push([{ text: '◀️ 返回', callback_data: `back_settings_${bindingId}` }]);
    
    if (messageId) {
      await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
    } else {
      await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
    }
  } catch (error) {
    console.error('[Telegram] 显示 PID 设置失败:', error);
    await bot.sendMessage(chatId, '❌ 获取 PID 列表失败');
  }
}

/**
 * 切换单个 PID 的通知开关
 */
async function togglePidSetting(bindingId, pid, telegramId) {
  try {
    const [bindings] = await db.query('SELECT id FROM telegram_bindings WHERE id = ? AND telegram_id = ?', [bindingId, telegramId]);
    if (bindings.length === 0) return;
    
    await db.query(
      `INSERT INTO telegram_pid_settings (binding_id, pid, enabled) VALUES (?, ?, 0)
       ON DUPLICATE KEY UPDATE enabled = NOT enabled`,
      [bindingId, pid]
    );
  } catch (error) {
    console.error('[Telegram] 切换 PID 设置失败:', error);
  }
}

// ==================== 消息发送 ====================

async function sendNotification(data) {
  if (!bot || !isRunning) return false;
  
  try {
    const { chatId, message, options = {} } = data;
    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', ...options });
    return true;
  } catch (error) {
    console.error('[Telegram] 发送通知失败:', error.message);
    return false;
  }
}

async function processQueue() {
  if (isProcessing || messageQueue.length === 0) return;
  
  isProcessing = true;
  while (messageQueue.length > 0) {
    const msg = messageQueue.shift();
    await sendNotification(msg);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  isProcessing = false;
}

function queueMessage(data) {
  messageQueue.push(data);
  processQueue();
}

function sendMessage(chatId, message, options = {}) {
  if (!isRunning) return false;
  queueMessage({ chatId, message, options });
  return true;
}

// ==================== 订单/支付通知 ====================

async function notifyPayment(orderInfo) {
  const { trade_no, out_trade_no, money, real_money, type, name, status, merchant_id, pid } = orderInfo;
  
  const payTypeNames = { alipay: '支付宝', wxpay: '微信支付', qqpay: 'QQ钱包', bank: '网银支付', jdpay: '京东支付', paypal: 'PayPal', ecny: '数字人民币' };
  const statusInfo = status === 2 ? { emoji: '✅', text: '已完成' } : { emoji: '⚠️', text: '已支付(未回调)' };
  
  const message = `
💰 *收款通知* ${statusInfo.emoji}

订单号：\`${trade_no}\`
商户单号：\`${out_trade_no || '-'}\`
商品名：${name || '-'}
支付方式：${payTypeNames[type] || type}
订单金额：¥${parseFloat(money).toFixed(2)}
实付金额：¥${parseFloat(real_money || money).toFixed(2)}
状态：*${statusInfo.text}*
PID：${pid}

时间：${new Date().toLocaleString('zh-CN')}
`.trim();
  
  await notifyUserWithPid(merchant_id, 'merchant', 'payment', message, pid);
  await notifyMerchantRAM(merchant_id, 'payment', message, pid);
}

async function notifyMerchantRAM(merchantId, notifyType, message, pid = null) {
  try {
    const [rams] = await db.query(`
      SELECT ur.id as ram_id, ur.user_id, ur.permissions, tb.id as binding_id, tb.chat_id, 
             tb.notify_payment, tb.notify_balance, tb.notify_settlement, tb.enabled
      FROM user_ram ur
      INNER JOIN telegram_bindings tb ON ur.user_id = tb.user_id AND tb.user_type = 'ram'
      WHERE ur.owner_id = ? AND ur.owner_type = 'merchant' AND ur.status = 1 AND tb.enabled = 1
    `, [merchantId]);
    
    for (const ram of rams) {
      let hasPermission = false;
      let permissions = [];
      try {
        permissions = typeof ram.permissions === 'string' ? JSON.parse(ram.permissions) : (ram.permissions || []);
      } catch (e) {
        permissions = [];
      }
      
      if (permissions.includes('admin')) {
        hasPermission = true;
      } else {
        switch (notifyType) {
          case 'payment':
            // 商户RAM权限: admin, order, finance
            hasPermission = ram.notify_payment === 1 && permissions.includes('order');
            break;
          case 'balance':
            hasPermission = ram.notify_balance === 1 && permissions.includes('finance');
            break;
          case 'settlement':
            hasPermission = ram.notify_settlement === 1 && permissions.includes('finance');
            break;
        }
      }
      
      if (hasPermission) {
        if (pid) {
          const [pidSettings] = await db.query('SELECT enabled FROM telegram_pid_settings WHERE binding_id = ? AND pid = ?', [ram.binding_id, pid]);
          if (pidSettings.length > 0 && pidSettings[0].enabled === 0) continue;
        }
        sendMessage(ram.chat_id, `👤 *[RAM通知]*\n\n${message}`);
      }
    }
  } catch (error) {
    console.error('[Telegram] 通知商户 RAM 失败:', error.message);
  }
}

// ==================== 结算通知 ====================

async function notifySettlementToMerchant(settlementInfo) {
  const { settle_no, merchant_id, amount, real_amount, provider_name } = settlementInfo;
  
  const message = `
📋 *结算通知*

结算单号：\`${settle_no}\`
服务商：${provider_name}
结算金额：¥${parseFloat(amount).toFixed(2)}
实际到账：¥${parseFloat(real_amount).toFixed(2)}
状态：待处理

时间：${new Date().toLocaleString('zh-CN')}
`.trim();
  
  await notifyUser(merchant_id, 'merchant', 'settlement', message);
  await notifyMerchantRAM(merchant_id, 'settlement', message);
}

async function notifySettlementStatus(info) {
  const { settle_no, amount, real_amount, status, remark, user_id, user_type } = info;
  
  const statusNames = { 0: '待审核', 1: '已完成', 2: '处理中', 3: '已拒绝' };
  const statusEmojis = { 0: '⏳', 1: '✅', 2: '🔄', 3: '❌' };
  
  const message = `
${statusEmojis[status] || '📋'} *结算状态更新*

结算单号：\`${settle_no}\`
申请金额：¥${parseFloat(amount).toFixed(2)}
实际到账：¥${parseFloat(real_amount).toFixed(2)}
状态：*${statusNames[status] || '未知'}*
${remark ? `备注：${remark}` : ''}

时间：${new Date().toLocaleString('zh-CN')}
`.trim();
  
  await notifyUser(user_id, user_type, 'settlement', message);
  if (user_type === 'merchant') {
    await notifyMerchantRAM(user_id, 'settlement', message);
  }
}

async function notifyAutoSettlement(info) {
  const { provider_id, merchant_count, total_amount, settle_count } = info;
  
  const message = `
🔔 *自动结算提醒*

系统已为您自动生成 ${settle_count} 笔结算单
涉及商户：${merchant_count} 个
总金额：¥${parseFloat(total_amount).toFixed(2)}

请及时处理结算申请！

时间：${new Date().toLocaleString('zh-CN')}
`.trim();
  
  await notifyUser(provider_id, 'admin', 'settlement', message);
}

// ==================== 余额变动通知 ====================

async function notifyBalance(userId, userType, changeInfo) {
  const { type, amount, balance, reason } = changeInfo;
  
  const typeNames = { income: '收入', expense: '支出', freeze: '冻结', unfreeze: '解冻', settlement: '结算', refund: '退款' };
  const emoji = ['income', 'unfreeze'].includes(type) ? '📈' : '📉';
  const sign = ['income', 'unfreeze'].includes(type) ? '+' : '-';
  
  const message = `
${emoji} *余额变动*

类型：${typeNames[type] || type}
金额：${sign}¥${parseFloat(amount).toFixed(2)}
余额：¥${parseFloat(balance).toFixed(2)}
${reason ? `原因：${reason}` : ''}

时间：${new Date().toLocaleString('zh-CN')}
`.trim();
  
  await notifyUser(userId, userType, 'balance', message);
  if (userType === 'merchant') {
    await notifyMerchantRAM(userId, 'balance', message);
  }
}

// ==================== 通用通知方法 ====================

async function notifyUser(userId, userType, notifyType, message) {
  try {
    const [rows] = await db.query(
      `SELECT id, chat_id, notify_payment, notify_balance, notify_settlement, enabled
       FROM telegram_bindings WHERE user_id = ? AND user_type = ? AND enabled = 1`,
      [String(userId), userType]
    );
    
    if (rows.length === 0) return false;
    
    const binding = rows[0];
    const notifyField = `notify_${notifyType}`;
    if (binding[notifyField] !== 1) return false;
    
    return sendMessage(binding.chat_id, message);
  } catch (error) {
    console.error('[Telegram] 发送通知失败:', error.message);
    return false;
  }
}

async function notifyUserWithPid(userId, userType, notifyType, message, pid) {
  try {
    const [rows] = await db.query(
      `SELECT id, chat_id, notify_payment, notify_balance, notify_settlement, enabled
       FROM telegram_bindings WHERE user_id = ? AND user_type = ? AND enabled = 1`,
      [String(userId), userType]
    );
    
    if (rows.length === 0) return false;
    
    const binding = rows[0];
    const notifyField = `notify_${notifyType}`;
    if (binding[notifyField] !== 1) return false;
    
    if (pid && userType === 'merchant') {
      const [pidSettings] = await db.query('SELECT enabled FROM telegram_pid_settings WHERE binding_id = ? AND pid = ?', [binding.id, pid]);
      if (pidSettings.length > 0 && pidSettings[0].enabled === 0) return false;
    }
    
    return sendMessage(binding.chat_id, message);
  } catch (error) {
    console.error('[Telegram] 发送通知失败:', error.message);
    return false;
  }
}

// ==================== 绑定管理 ====================

async function generateBindToken(userId, userType) {
  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  
  await db.query('DELETE FROM telegram_bind_tokens WHERE user_id = ? AND user_type = ?', [String(userId), userType]);
  await db.query('INSERT INTO telegram_bind_tokens (user_id, user_type, token, expires_at) VALUES (?, ?, ?, ?)', [String(userId), userType, token, expiresAt]);
  
  return token;
}

async function getBindLink(userId, userType, botUsername) {
  const token = await generateBindToken(userId, userType);
  return `https://t.me/${botUsername || config.botName}?start=${token}`;
}

async function isUserBound(userId, userType) {
  const [rows] = await db.query('SELECT id FROM telegram_bindings WHERE user_id = ? AND user_type = ?', [String(userId), userType]);
  return rows.length > 0;
}

async function getUserBinding(userId, userType) {
  const [rows] = await db.query('SELECT * FROM telegram_bindings WHERE user_id = ? AND user_type = ?', [String(userId), userType]);
  return rows[0] || null;
}

async function unbind(userId, userType) {
  await db.query('DELETE FROM telegram_bindings WHERE user_id = ? AND user_type = ?', [String(userId), userType]);
}

// ==================== 管理员通知 ====================

async function notifyAdmins(message, options = {}) {
  try {
    // 查询所有已绑定的管理员
    // telegram_bindings.user_id 存储的是 users.id 的字符串形式
    const [admins] = await db.query(`
      SELECT tb.chat_id FROM telegram_bindings tb
      INNER JOIN users u ON CAST(tb.user_id AS UNSIGNED) = u.id
      WHERE tb.user_type = 'admin' AND u.is_admin = 1 AND tb.enabled = 1
    `);
    
    if (admins.length === 0) {
      console.log('[Telegram] 没有已绑定的管理员，跳过管理员通知');
      return false;
    }
    
    for (const admin of admins) {
      sendMessage(admin.chat_id, message, options);
    }
    return true;
  } catch (error) {
    console.error('[Telegram] 查询管理员失败:', error.message);
    return false;
  }
}

function notifyAdminNewUser(userInfo) {
  const { username, email, user_type } = userInfo;
  const typeNames = { merchant: '商户', provider: '服务商' };
  
  const message = `
👤 *新用户注册*

用户名：\`${username}\`
邮箱：${email || '-'}
类型：${typeNames[user_type] || user_type}

时间：${new Date().toLocaleString('zh-CN')}
`.trim();
  
  return notifyAdmins(message, { parse_mode: 'Markdown' });
}

function notifyAdminWithdrawRequest(settlementInfo) {
  const { settle_no, merchant_name, merchant_id, amount, settle_type, account_info } = settlementInfo;
  
  const message = `
📋 *提现申请*

结算单号：\`${settle_no}\`
商户：${merchant_name || merchant_id}
金额：¥${parseFloat(amount).toFixed(2)}
结算方式：${settle_type || '-'}
${account_info ? `收款账户：${account_info}` : ''}

时间：${new Date().toLocaleString('zh-CN')}
`.trim();
  
  return notifyAdmins(message, { parse_mode: 'Markdown' });
}

// ==================== Express 路由 ====================

const router = express.Router();

// 认证中间件
const authMiddleware = async (req, res, next) => {
  try {
    const sessionId = req.cookies.sessionId;
    if (!sessionId) {
      return res.json({ code: -401, msg: '未登录' });
    }

    if (sessionId.startsWith('ram_')) {
      const [sessions] = await db.query(
        `SELECT s.user_id, s.user_type, ur.owner_id, ur.owner_type
         FROM sessions s JOIN user_ram ur ON s.user_id = ur.user_id
         WHERE s.session_token = ? AND ur.status = 1`,
        [sessionId]
      );
      if (sessions.length === 0) {
        return res.json({ code: -401, msg: '会话无效' });
      }
      req.user = {
        user_id: sessions[0].owner_id,
        user_type: sessions[0].owner_type,
        is_ram: true,
        ram_user_id: sessions[0].user_id
      };
    } else {
      const [sessions] = await db.query('SELECT user_id, user_type FROM sessions WHERE session_token = ?', [sessionId]);
      if (sessions.length === 0) {
        return res.json({ code: -401, msg: '会话无效' });
      }
      req.user = { user_id: sessions[0].user_id, user_type: sessions[0].user_type, is_ram: false };
    }
    next();
  } catch (err) {
    console.error('认证错误:', err);
    return res.json({ code: -401, msg: '认证失败' });
  }
};

// 生成绑定 Token
router.post('/bindToken', authMiddleware, async (req, res) => {
  try {
    const { user_id, user_type } = req.user;
    
    await db.query('DELETE FROM telegram_bind_tokens WHERE user_type = ? AND user_id = ?', [user_type, String(user_id)]);
    
    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10分钟有效期
    
    await db.query('INSERT INTO telegram_bind_tokens (token, user_type, user_id, expires_at) VALUES (?, ?, ?, ?)', [token, user_type, String(user_id), expiresAt]);
    
    const bindUrl = `https://t.me/${config.botName}?start=${token}`;
    const bindCommand = `/bind ${token}`;
    
    res.json({ 
      code: 0, 
      data: { 
        token,           // 绑定码
        bindUrl,         // 直接点击链接绑定
        bindCommand,     // 手动输入命令绑定
        botName: config.botName,
        expiresAt: expiresAt.toISOString(),
        expiresIn: 600   // 有效期（秒）
      } 
    });
  } catch (err) {
    console.error('生成绑定码失败:', err);
    res.json({ code: -1, msg: '生成绑定码失败' });
  }
});

// 获取绑定状态
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const { user_id, user_type } = req.user;
    
    const [rows] = await db.query(
      `SELECT chat_id, username, nickname, notify_payment, notify_balance, notify_settlement, enabled, created_at
       FROM telegram_bindings WHERE user_type = ? AND user_id = ?`,
      [user_type, String(user_id)]
    );
    
    if (rows.length === 0) {
      return res.json({ code: 0, data: { bound: false } });
    }
    
    const binding = rows[0];
    res.json({
      code: 0,
      data: {
        bound: true,
        username: binding.username,
        nickname: binding.nickname,
        notifyPayment: binding.notify_payment === 1,
        notifyBalance: binding.notify_balance === 1,
        notifySettlement: binding.notify_settlement === 1,
        enabled: binding.enabled === 1,
        createdAt: binding.created_at
      }
    });
  } catch (err) {
    console.error('获取绑定状态失败:', err);
    res.json({ code: -1, msg: '获取绑定状态失败' });
  }
});

// 解除绑定
router.post('/unbind', authMiddleware, async (req, res) => {
  try {
    const { user_id, user_type } = req.user;
    
    const [result] = await db.query('DELETE FROM telegram_bindings WHERE user_type = ? AND user_id = ?', [user_type, user_id]);
    
    if (result.affectedRows === 0) {
      return res.json({ code: -1, msg: '未找到绑定记录' });
    }
    
    res.json({ code: 0, msg: '解绑成功' });
  } catch (err) {
    console.error('解除绑定失败:', err);
    res.json({ code: -1, msg: '解除绑定失败' });
  }
});

// 更新通知设置
router.post('/settings', authMiddleware, async (req, res) => {
  try {
    const { user_id, user_type } = req.user;
    const { notifyPayment, notifyBalance, notifySettlement, enabled } = req.body;
    
    await db.query(
      `UPDATE telegram_bindings SET notify_payment = ?, notify_balance = ?, notify_settlement = ?, enabled = ?
       WHERE user_type = ? AND user_id = ?`,
      [notifyPayment ? 1 : 0, notifyBalance ? 1 : 0, notifySettlement ? 1 : 0, enabled ? 1 : 0, user_type, String(user_id)]
    );
    
    res.json({ code: 0, msg: '设置已更新' });
  } catch (err) {
    console.error('更新通知设置失败:', err);
    res.json({ code: -1, msg: '更新设置失败' });
  }
});

// 发送测试消息
router.post('/test', authMiddleware, async (req, res) => {
  try {
    const { user_id, user_type } = req.user;
    
    const [rows] = await db.query(
      'SELECT chat_id FROM telegram_bindings WHERE user_type = ? AND user_id = ? AND enabled = 1',
      [user_type, user_id]
    );
    
    if (rows.length === 0) {
      return res.json({ code: -1, msg: '未绑定或已禁用通知' });
    }
    
    await sendMessage(
      rows[0].chat_id,
      `🔔 测试通知\n\n这是一条测试消息，如果您收到此消息，说明 Telegram 通知功能正常工作！\n\n发送时间：${new Date().toLocaleString('zh-CN')}`
    );
    
    res.json({ code: 0, msg: '测试消息已发送' });
  } catch (err) {
    console.error('发送测试消息失败:', err);
    res.json({ code: -1, msg: '发送测试消息失败' });
  }
});

// ==================== 导出 ====================

module.exports = {
  // 配置
  config,
  
  // Bot 控制
  start,
  stop,
  sendMessage,
  
  // 路由
  router,
  
  // 用户通知
  notifyPayment,
  notifyBalance,
  notifySettlementToMerchant,
  notifySettlementStatus,
  notifyAutoSettlement,
  notifyUser,
  notifyMerchantRAM,
  
  // 管理员通知
  notifyAdminNewUser,
  notifyAdminWithdrawRequest,
  notifyAdmins,
  
  // 绑定管理
  generateBindToken,
  getBindLink,
  isUserBound,
  getUserBinding,
  unbind
};
