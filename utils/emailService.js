/**
 * 邮件服务 - 主线程运行
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

class EmailService {
  constructor() {
    this.config = loadConfig();
    this.emailConfig = this.config?.email || {};
    this.transporter = null;
    this.isReady = false;
    
    // 如果配置有效，初始化传输器
    if (this.isEnabled()) {
      this._initTransporter();
    }
  }

  /**
   * 初始化邮件传输器
   */
  _initTransporter() {
    this.transporter = nodemailer.createTransport({
      host: this.emailConfig.host,
      port: this.emailConfig.port,
      secure: this.emailConfig.secure !== false,
      auth: {
        user: this.emailConfig.user,
        pass: this.emailConfig.pass
      }
    });
  }

  /**
   * 检查邮件功能是否启用
   */
  isEnabled() {
    const cfg = this.emailConfig;
    return cfg && cfg.enabled && cfg.host && cfg.port && cfg.user && cfg.pass;
  }

  /**
   * 启动邮件服务（验证SMTP连接）
   */
  async start() {
    if (!this.isEnabled()) {
      console.log('[Email] 邮件功能未启用，跳过启动');
      return;
    }

    try {
      await this.transporter.verify();
      this.isReady = true;
      console.log('[Email] SMTP 连接成功，邮件服务已就绪');
    } catch (error) {
      console.error('[Email] SMTP 连接失败:', error.message);
      this.isReady = false;
    }
  }

  /**
   * 停止邮件服务
   */
  stop() {
    if (this.transporter) {
      this.transporter.close();
      this.transporter = null;
      this.isReady = false;
    }
  }

  /**
   * 发送验证码邮件
   * @param {string} to - 收件人邮箱
   * @param {string} code - 验证码
   * @param {string} type - 类型：register/reset
   */
  async sendVerificationEmail(to, code, type = 'register') {
    // 如果邮件功能未启用，直接返回成功（跳过验证）
    if (!this.isEnabled()) {
      console.log('[Email] 邮件功能未启用，跳过发送');
      return;
    }

    if (!this.transporter) {
      throw new Error('邮件服务未初始化');
    }

    const siteName = this.config?.siteName || 'LunaFir';
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

    const from = this.emailConfig.from || `"${siteName}" <${this.emailConfig.user}>`;

    const mailOptions = {
      from,
      to,
      subject,
      html
    };

    return this.transporter.sendMail(mailOptions);
  }
}

// 单例
const emailService = new EmailService();

module.exports = emailService;
