/**
 * 证书管理路由
 * 用于支付插件证书的上传、查看、删除
 */
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const certValidator = require('../utils/certValidator');
const pluginIndex = require('../plugins/index');
const db = require('../config/database');

// 认证中间件 - 验证是否已登录（只允许供应商操作）
const authMiddleware = async (req, res, next) => {
  try {
    const sessionId = req.cookies.sessionId;
    if (!sessionId) {
      return res.json({ code: -401, msg: '未登录' });
    }

    // 检查session
    const [sessions] = await db.query(
      'SELECT user_id, user_type FROM sessions WHERE session_token = ?',
      [sessionId]
    );

    if (sessions.length === 0) {
      return res.json({ code: -401, msg: '会话无效' });
    }

    // 只允许管理员操作证书
    if (sessions[0].user_type !== 'admin') {
      return res.json({ code: -403, msg: '无权限操作' });
    }

    req.user = {
      user_id: sessions[0].user_id,
      user_type: sessions[0].user_type
    };
    next();
  } catch (err) {
    console.error('认证错误:', err);
    return res.json({ code: -401, msg: '认证失败' });
  }
};

// 配置multer用于文件上传
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 1024 * 1024, // 1MB
        files: 1
    },
    fileFilter: (req, file, cb) => {
        // 只允许特定扩展名
        const allowedExt = ['.pfx', '.p12', '.cer', '.crt', '.pem', '.key'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowedExt.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error(`不支持的文件类型: ${ext}`), false);
        }
    }
});

// 动态获取支持的支付插件列表 (需要证书的插件)
const getSupportedPlugins = () => {
    const pluginList = pluginIndex.getPluginList();
    return pluginList
        .filter(plugin => plugin.certs && plugin.certs.length > 0)
        .map(plugin => plugin.name);
};

/**
 * 上传证书
 * POST /api/cert/upload
 * Body: multipart/form-data
 *   - plugin: 插件名称
 *   - file: 证书文件
 *   - password: 证书密码 (PFX证书需要)
 *   - channelId: 通道ID (支付配置ID)
 */
router.post('/upload', authMiddleware, upload.single('file'), async (req, res) => {
    try {
        const { plugin, password, channelId } = req.body;
        const file = req.file;

        // 验证参数
        if (!plugin) {
            return res.json({ code: -1, msg: '请指定插件名称' });
        }

        const supportedPlugins = getSupportedPlugins();
        if (!supportedPlugins.includes(plugin)) {
            return res.json({ code: -1, msg: `不支持的插件: ${plugin}，此插件不需要证书` });
        }

        if (!file) {
            return res.json({ code: -1, msg: '请上传证书文件' });
        }

        // 保存证书 (传入 channelId 生成唯一文件名)
        const result = await certValidator.saveCertificate(
            file.buffer,
            plugin,
            file.originalname,
            password || '',
            channelId || ''
        );

        if (result.success) {
            res.json({
                code: 0,
                msg: result.message,
                data: {
                    // 返回文件名，用于存储到数据库
                    filename: result.filename,
                    originalFilename: result.originalFilename,
                    certInfo: result.certInfo
                }
            });
        } else {
            res.json({
                code: -1,
                msg: result.message,
                error: result.error
            });
        }
    } catch (error) {
        console.error('证书上传错误:', error);
        res.json({ code: -1, msg: '证书上传失败: ' + error.message });
    }
});

/**
 * 验证证书 (不保存，仅验证)
 * POST /api/cert/validate
 */
router.post('/validate', authMiddleware, upload.single('file'), async (req, res) => {
    try {
        const { password } = req.body;
        const file = req.file;

        if (!file) {
            return res.json({ code: -1, msg: '请上传证书文件' });
        }

        // 安全检查
        const securityResult = certValidator.securityCheck(file.buffer, file.originalname);
        if (!securityResult.safe) {
            return res.json({
                code: -1,
                msg: securityResult.message,
                error: securityResult.error
            });
        }

        // 验证证书
        const result = certValidator.validateCertificate(
            file.buffer,
            file.originalname,
            password || ''
        );

        if (result.valid) {
            res.json({
                code: 0,
                msg: result.message,
                data: {
                    type: result.type,
                    keyType: result.keyType,
                    modulusLength: result.modulusLength
                }
            });
        } else {
            res.json({
                code: -1,
                msg: result.message,
                error: result.error
            });
        }
    } catch (error) {
        console.error('证书验证错误:', error);
        res.json({ code: -1, msg: '证书验证失败: ' + error.message });
    }
});

/**
 * 获取插件的证书列表
 * GET /api/cert/list/:plugin
 */
router.get('/list/:plugin', authMiddleware, (req, res) => {
    try {
        const { plugin } = req.params;

        const supportedPlugins = getSupportedPlugins();
        if (!supportedPlugins.includes(plugin)) {
            return res.json({ code: -1, msg: `不支持的插件: ${plugin}` });
        }

        const certs = certValidator.listCertificates(plugin);
        res.json({
            code: 0,
            data: certs
        });
    } catch (error) {
        console.error('获取证书列表错误:', error);
        res.json({ code: -1, msg: '获取证书列表失败: ' + error.message });
    }
});

/**
 * 删除证书
 * DELETE /api/cert/:plugin/:filename
 */
router.delete('/:plugin/:filename', authMiddleware, (req, res) => {
    try {
        const { plugin, filename } = req.params;

        const supportedPlugins = getSupportedPlugins();
        if (!supportedPlugins.includes(plugin)) {
            return res.json({ code: -1, msg: `不支持的插件: ${plugin}` });
        }

        const result = certValidator.deleteCertificate(plugin, filename);
        if (result) {
            res.json({ code: 0, msg: '证书删除成功' });
        } else {
            res.json({ code: -1, msg: '证书不存在或删除失败' });
        }
    } catch (error) {
        console.error('删除证书错误:', error);
        res.json({ code: -1, msg: '删除证书失败: ' + error.message });
    }
});

/**
 * 获取支持的插件列表
 * GET /api/cert/plugins
 */
router.get('/plugins', authMiddleware, (req, res) => {
    const supportedPlugins = getSupportedPlugins();
    res.json({
        code: 0,
        data: supportedPlugins.map(plugin => ({
            name: plugin,
            certs: certValidator.listCertificates(plugin)
        }))
    });
});

module.exports = router;
