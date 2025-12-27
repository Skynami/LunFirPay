/**
 * 证书验证工具
 * 用于验证上传的证书文件是否为有效证书，防止上传恶意文件
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 证书存放目录 (统一目录，不再按插件分)
const CERT_DIR = path.join(__dirname, '..', 'pfx');

// 支持的证书类型
const CERT_TYPES = {
    PFX: ['.pfx', '.p12'],      // PKCS#12 格式私钥证书
    CER: ['.cer', '.crt', '.pem'], // 公钥证书
    KEY: ['.key']               // 私钥文件
};

// 文件大小限制 (1MB)
const MAX_FILE_SIZE = 1024 * 1024;

/**
 * 验证PFX/P12证书文件
 * @param {Buffer} buffer - 证书文件内容
 * @param {string} password - 证书密码
 * @returns {object} - 验证结果
 */
function validatePfxCertificate(buffer, password) {
    try {
        // 尝试使用密码解析PFX证书
        const privateKey = crypto.createPrivateKey({
            key: buffer,
            format: 'pkcs12',
            passphrase: password || ''
        });

        // 如果能成功创建私钥对象，说明是有效的PFX证书
        const keyDetails = privateKey.asymmetricKeyDetails;

        return {
            valid: true,
            type: 'PFX',
            keyType: privateKey.asymmetricKeyType,
            modulusLength: keyDetails?.modulusLength,
            message: '有效的PFX证书'
        };
    } catch (error) {
        // 检查是否是密码错误
        if (error.message.includes('mac verify failure') || 
            error.message.includes('bad decrypt') ||
            error.message.includes('wrong password')) {
            return {
                valid: false,
                type: 'PFX',
                error: 'PASSWORD_ERROR',
                message: '证书密码错误'
            };
        }
        
        return {
            valid: false,
            type: 'PFX',
            error: 'INVALID_CERTIFICATE',
            message: '无效的PFX证书文件: ' + error.message
        };
    }
}

/**
 * 验证CER/CRT/PEM公钥证书文件
 * @param {Buffer} buffer - 证书文件内容
 * @returns {object} - 验证结果
 */
function validatePublicCertificate(buffer) {
    try {
        let certContent = buffer.toString();
        
        // 检查是否是PEM格式
        if (certContent.includes('-----BEGIN CERTIFICATE-----')) {
            // 已经是PEM格式
        } else {
            // 尝试将DER格式转换为PEM格式
            const base64Cert = buffer.toString('base64').match(/.{1,64}/g).join('\n');
            certContent = `-----BEGIN CERTIFICATE-----\n${base64Cert}\n-----END CERTIFICATE-----`;
        }

        // 尝试创建公钥对象
        const publicKey = crypto.createPublicKey(certContent);

        const keyDetails = publicKey.asymmetricKeyDetails;

        return {
            valid: true,
            type: 'CER',
            keyType: publicKey.asymmetricKeyType,
            modulusLength: keyDetails?.modulusLength,
            message: '有效的公钥证书'
        };
    } catch (error) {
        return {
            valid: false,
            type: 'CER',
            error: 'INVALID_CERTIFICATE',
            message: '无效的公钥证书文件: ' + error.message
        };
    }
}

/**
 * 验证证书文件
 * @param {Buffer} buffer - 文件内容
 * @param {string} filename - 文件名
 * @param {string} password - 证书密码 (仅PFX需要)
 * @returns {object} - 验证结果
 */
function validateCertificate(buffer, filename, password = '') {
    // 检查文件大小
    if (buffer.length > MAX_FILE_SIZE) {
        return {
            valid: false,
            error: 'FILE_TOO_LARGE',
            message: `文件大小超过限制 (最大 ${MAX_FILE_SIZE / 1024}KB)`
        };
    }

    // 检查文件大小最小值 (至少100字节)
    if (buffer.length < 100) {
        return {
            valid: false,
            error: 'FILE_TOO_SMALL',
            message: '文件太小，不是有效的证书文件'
        };
    }

    const ext = path.extname(filename).toLowerCase();

    // 根据扩展名判断证书类型
    if (CERT_TYPES.PFX.includes(ext)) {
        return validatePfxCertificate(buffer, password);
    } else if (CERT_TYPES.CER.includes(ext)) {
        return validatePublicCertificate(buffer);
    } else {
        return {
            valid: false,
            error: 'UNSUPPORTED_TYPE',
            message: `不支持的证书类型: ${ext}，支持的类型: ${[...CERT_TYPES.PFX, ...CERT_TYPES.CER].join(', ')}`
        };
    }
}

/**
 * 检查文件头部魔数，初步判断文件类型
 * @param {Buffer} buffer - 文件内容
 * @returns {string|null} - 文件类型
 */
function detectFileType(buffer) {
    if (buffer.length < 4) return null;

    // PFX/P12 文件通常以 30 82 开头 (ASN.1 SEQUENCE)
    if (buffer[0] === 0x30 && buffer[1] === 0x82) {
        return 'ASN1'; // 可能是 PFX 或 DER 格式证书
    }

    // PEM格式证书以 "-----BEGIN" 开头
    const header = buffer.slice(0, 20).toString('utf8');
    if (header.startsWith('-----BEGIN')) {
        return 'PEM';
    }

    // 检查是否是可执行文件 (MZ 头)
    if (buffer[0] === 0x4D && buffer[1] === 0x5A) {
        return 'EXECUTABLE';
    }

    // 检查是否是ZIP文件 (PK头)
    if (buffer[0] === 0x50 && buffer[1] === 0x4B) {
        return 'ZIP';
    }

    // 检查是否是RAR文件
    if (buffer[0] === 0x52 && buffer[1] === 0x61 && buffer[2] === 0x72) {
        return 'RAR';
    }

    return 'UNKNOWN';
}

/**
 * 安全检查 - 检测可能的恶意文件
 * @param {Buffer} buffer - 文件内容
 * @param {string} filename - 文件名
 * @returns {object} - 检查结果
 */
function securityCheck(buffer, filename) {
    const fileType = detectFileType(buffer);

    // 检查是否是可执行文件
    if (fileType === 'EXECUTABLE') {
        return {
            safe: false,
            error: 'EXECUTABLE_FILE',
            message: '检测到可执行文件，禁止上传'
        };
    }

    // 检查文件名是否包含危险字符
    const dangerousPatterns = [
        /\.\./,           // 路径遍历
        /[<>:"|?*]/,      // Windows非法字符
        /\x00/,           // 空字节
        /\.exe$/i,
        /\.dll$/i,
        /\.bat$/i,
        /\.cmd$/i,
        /\.ps1$/i,
        /\.vbs$/i,
        /\.js$/i,         // JavaScript文件
        /\.php$/i,
        /\.asp$/i,
        /\.jsp$/i,
        /\.sh$/i
    ];

    for (const pattern of dangerousPatterns) {
        if (pattern.test(filename)) {
            return {
                safe: false,
                error: 'DANGEROUS_FILENAME',
                message: '文件名包含危险字符或扩展名'
            };
        }
    }

    // 检查文件内容是否包含可疑脚本
    const content = buffer.toString('utf8', 0, Math.min(buffer.length, 1000));
    const suspiciousPatterns = [
        /<script/i,
        /<%/,
        /<\?php/i,
        /eval\s*\(/i,
        /exec\s*\(/i,
        /system\s*\(/i
    ];

    for (const pattern of suspiciousPatterns) {
        if (pattern.test(content)) {
            return {
                safe: false,
                error: 'SUSPICIOUS_CONTENT',
                message: '文件内容包含可疑代码'
            };
        }
    }

    return { safe: true };
}

/**
 * 生成唯一文件名
 * 格式: {timestamp}_{channelId}.{ext}
 * @param {string} channelId - 支付配置ID (通道ID)
 * @param {string} originalFilename - 原始文件名 (用于获取扩展名)
 * @returns {string} - 唯一文件名
 */
function generateUniqueFilename(channelId, originalFilename) {
    const ext = path.extname(originalFilename).toLowerCase();
    const timestamp = Date.now();
    return `${timestamp}_${channelId || '0'}${ext}`;
}

/**
 * 保存证书文件
 * @param {Buffer} buffer - 文件内容
 * @param {string} plugin - 插件名称 (如 ysepay, sandpay) - 仅用于日志
 * @param {string} filename - 原始文件名
 * @param {string} password - 证书密码 (仅PFX需要)
 * @param {string} channelId - 支付配置ID (通道ID)
 * @returns {object} - 保存结果 (包含文件名)
 */
async function saveCertificate(buffer, plugin, filename, password = '', channelId = '') {
    // 安全检查
    const securityResult = securityCheck(buffer, filename);
    if (!securityResult.safe) {
        return {
            success: false,
            error: securityResult.error,
            message: securityResult.message
        };
    }

    // 获取扩展名
    const ext = path.extname(filename).toLowerCase();
    
    // 根据扩展名判断是否需要验证
    // .key 文件不做证书验证，直接保存
    if (!CERT_TYPES.KEY.includes(ext)) {
        // 验证证书
        const validationResult = validateCertificate(buffer, filename, password);
        if (!validationResult.valid) {
            return {
                success: false,
                error: validationResult.error,
                message: validationResult.message
            };
        }
    }

    // 确保证书目录存在
    if (!fs.existsSync(CERT_DIR)) {
        fs.mkdirSync(CERT_DIR, { recursive: true });
    }

    // 生成唯一文件名: {timestamp}_{channelId}.{ext}
    const uniqueFilename = generateUniqueFilename(channelId, filename);
    const absolutePath = path.join(CERT_DIR, uniqueFilename);

    // 保存文件
    try {
        fs.writeFileSync(absolutePath, buffer);
        
        // 获取证书信息（如果是证书文件）
        let certInfo = null;
        if (!CERT_TYPES.KEY.includes(ext)) {
            const validationResult = validateCertificate(buffer, filename, password);
            certInfo = {
                type: validationResult.type,
                keyType: validationResult.keyType,
                modulusLength: validationResult.modulusLength
            };
        }
        
        return {
            success: true,
            message: '证书保存成功',
            filename: uniqueFilename,  // 返回文件名（数据库存储用）
            originalFilename: filename,
            absolutePath: absolutePath,
            certInfo: certInfo
        };
    } catch (error) {
        return {
            success: false,
            error: 'SAVE_ERROR',
            message: '保存文件失败: ' + error.message
        };
    }
}

/**
 * 根据文件名获取绝对路径
 * @param {string} filename - 文件名 (如 1234567890_1_2.pfx) 或相对路径 (兼容旧格式)
 * @returns {string|null} - 绝对路径
 */
function getAbsolutePath(filename) {
    if (!filename) return null;
    
    // 如果是相对路径格式 (pfx/xxx/xxx.pfx)，提取文件名
    if (filename.includes('/')) {
        filename = path.basename(filename);
    }
    
    // 直接在 pfx 目录下查找
    const absolutePath = path.join(CERT_DIR, filename);
    if (fs.existsSync(absolutePath)) {
        return absolutePath;
    }
    
    return null;
}

/**
 * 获取证书路径 (兼容旧方法)
 * @param {string} plugin - 插件名称
 * @param {string} filename - 文件名
 * @returns {string|null} - 证书绝对路径
 */
function getCertPath(plugin, filename) {
    const filePath = path.join(CERT_DIR, plugin, filename);
    if (fs.existsSync(filePath)) {
        return filePath;
    }
    return null;
}

/**
 * 列出插件的所有证书
 * @param {string} plugin - 插件名称
 * @returns {array} - 证书列表
 */
function listCertificates(plugin) {
    const pluginCertDir = path.join(CERT_DIR, plugin);
    if (!fs.existsSync(pluginCertDir)) {
        return [];
    }

    const files = fs.readdirSync(pluginCertDir);
    return files.map(file => {
        const filePath = path.join(pluginCertDir, file);
        const stats = fs.statSync(filePath);
        const ext = path.extname(file).toLowerCase();
        return {
            name: file,
            size: stats.size,
            type: CERT_TYPES.PFX.includes(ext) ? 'PFX' : 'CER',
            uploadTime: stats.mtime
        };
    });
}

/**
 * 删除证书
 * @param {string} plugin - 插件名称
 * @param {string} filename - 文件名
 * @returns {boolean} - 是否删除成功
 */
function deleteCertificate(plugin, filename) {
    // 安全检查文件名
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        return false;
    }

    const filePath = path.join(CERT_DIR, plugin, filename);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return true;
    }
    return false;
}

module.exports = {
    validateCertificate,
    validatePfxCertificate,
    validatePublicCertificate,
    securityCheck,
    saveCertificate,
    getCertPath,
    getAbsolutePath,
    generateUniqueFilename,
    listCertificates,
    deleteCertificate,
    CERT_DIR,
    CERT_TYPES
};
