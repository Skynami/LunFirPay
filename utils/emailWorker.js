/**
 * 邮件发送 Worker - 子进程运行，不阻塞主进程
 */
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// 加载配置
function loadConfig() {
  const configPath = path.join(__dirname, '..', 'config.yaml');
  if (!fs.existsSync(configPath)) {
    return null;
  }
  return yaml.load(fs.readFileSync(configPath, 'utf8'));
}

const config = loadConfig();
const emailConfig = config?.email || {};

// 检查邮件配置是否完整
function isEmailConfigValid() {
  return emailConfig.enabled && 
         emailConfig.host && 
         emailConfig.port && 
         emailConfig.user && 
         emailConfig.pass;
}

// 创建邮件传输器（仅在配置有效时）
let transporter = null;
if (isEmailConfigValid()) {
  transporter = nodemailer.createTransport({
    host: emailConfig.host,
    port: emailConfig.port,
    secure: emailConfig.secure !== false, // 默认true
    auth: {
      user: emailConfig.user,
      pass: emailConfig.pass
    }
  });

  // 验证连接
  transporter.verify((error, success) => {
    if (error) {
      console.error('[EmailWorker] SMTP 连接失败:', error.message);
    } else {
      console.log('[EmailWorker] SMTP 连接成功，准备发送邮件');
    }
  });
} else {
  console.log('[EmailWorker] 邮件功能未启用或配置不完整');
}

/**
 * 发送验证码邮件
 * @param {string} to - 收件人邮箱
 * @param {string} code - 验证码
 * @param {string} type - 类型：register/reset
 */
async function sendVerificationEmail(to, code, type = 'register') {
  if (!transporter) {
    throw new Error('邮件服务未配置');
  }

  const siteName = config?.siteName || 'LunaFir';
  const subject = type === 'register' ? `【${siteName}】注册验证码` : `【${siteName}】密码重置验证码`;
  const typeText = type === 'register' ? '注册账户' : '重置密码';
  
  const html = `
    <div style="max-width: 600px; margin: 0 auto; padding: 20px; font-family: Arial, sans-serif;">
      <div style="text-align: center; margin-bottom: 30px;">
        <h1 style="color: #2563eb; margin: 0;">${siteName}</h1>
      </div>
      <div style="background: #f8fafc; border-radius: 8px; padding: 30px; margin-bottom: 20px;">
        <h2 style="color: #1e293b; margin: 0 0 20px 0; font-size: 18px;">您正在${typeText}</h2>
        <p style="color: #64748b; margin: 0 0 20px 0; line-height: 1.6;">
          您的验证码是：
        </p>
        <div style="background: #2563eb; color: white; font-size: 32px; font-weight: bold; letter-spacing: 8px; text-align: center; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
          ${code}
        </div>
        <p style="color: #64748b; margin: 0; line-height: 1.6; font-size: 14px;">
          验证码有效期为 <strong>10分钟</strong>，请尽快使用。<br>
          如果这不是您的操作，请忽略此邮件。
        </p>
      </div>
      <div style="text-align: center; color: #94a3b8; font-size: 12px;">
        <p style="margin: 0;">此邮件由系统自动发送，请勿回复</p>
        <p style="margin: 10px 0 0 0;">© ${new Date().getFullYear()} ${siteName}</p>
      </div>
    </div>
  `;

  // 发件人地址
  const from = emailConfig.from || `"${siteName}" <${emailConfig.user}>`;

  const mailOptions = {
    from,
    to,
    subject,
    html
  };

  return transporter.sendMail(mailOptions);
}

// 处理来自主进程的消息
process.on('message', async (message) => {
  if (message.type === 'sendVerificationEmail') {
    const { to, code, emailType, requestId } = message;
    try {
      await sendVerificationEmail(to, code, emailType);
      process.send({ type: 'emailSent', requestId, success: true });
    } catch (error) {
      console.error('[EmailWorker] 发送邮件失败:', error.message);
      process.send({ type: 'emailSent', requestId, success: false, error: error.message });
    }
  }
});

// 通知主进程 Worker 已就绪
if (process.send) {
  process.send({ type: 'ready' });
}

console.log('[EmailWorker] 邮件发送服务已启动');
