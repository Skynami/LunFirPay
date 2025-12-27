/**
 * 京东支付插件
 * RSA签名 + 3DES加密
 * https://www.jdpay.com/
 */
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const certValidator = require('../../utils/certValidator');

const info = {
    name: 'jdpay',
    showname: '京东支付',
    author: '京东支付',
    link: 'https://www.jdpay.com/',
    types: ['jdpay'],
    inputs: {
        appid: {
            name: '商户号',
            type: 'input',
            note: ''
        },
        appkey: {
            name: '商户DES密钥',
            type: 'input',
            note: ''
        }
    },
    select: null,
    certs: [
        { key: 'privateCert', name: '商户私钥', ext: '.pem', desc: 'seller_rsa_private_key.pem', required: true }
    ],
    note: '请上传商户私钥 seller_rsa_private_key.pem',
    bindwxmp: false,
    bindwxa: false
};

// API网关
const GATEWAY_PC = 'https://wepay.jd.com/jdpay/saveOrder';
const GATEWAY_H5 = 'https://h5pay.jd.com/jdpay/saveOrder';
const GATEWAY_REFUND = 'https://paygate.jd.com/service/refund';

/**
 * 3DES加密
 */
function tdesEncrypt(data, keyBase64) {
    const key = Buffer.from(keyBase64, 'base64');
    const cipher = crypto.createCipheriv('des-ede3', key, null);
    cipher.setAutoPadding(true);
    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return encrypted.toUpperCase();
}

/**
 * 3DES解密
 */
function tdesDecrypt(encryptedHex, keyBase64) {
    const key = Buffer.from(keyBase64, 'base64');
    const decipher = crypto.createDecipheriv('des-ede3', key, null);
    decipher.setAutoPadding(true);
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

/**
 * SHA256哈希
 */
function sha256(str) {
    return crypto.createHash('sha256').update(str).digest('hex');
}

/**
 * 获取签名字符串
 */
function getSignString(params, unsignKeys = []) {
    const keys = Object.keys(params).sort();
    const parts = [];
    for (const key of keys) {
        if (!unsignKeys.includes(key) && params[key] !== null && params[key] !== undefined && params[key] !== '') {
            parts.push(`${key}=${params[key]}`);
        }
    }
    return parts.join('&');
}

/**
 * 从通道配置获取证书绝对路径
 */
function getCertAbsolutePath(channel, certKey) {
    let config = channel.config;
    if (typeof config === 'string') {
        try {
            config = JSON.parse(config);
        } catch (e) {
            return null;
        }
    }
    
    const certFilename = config?.certs?.[certKey]?.filename;
    if (!certFilename) return null;
    
    return certValidator.getAbsolutePath(certFilename);
}

/**
 * 加载商户私钥
 */
function loadPrivateKey(channel) {
    const certPath = getCertAbsolutePath(channel, 'privateCert');
    if (certPath && fs.existsSync(certPath)) {
        return fs.readFileSync(certPath, 'utf8');
    }
    throw new Error('商户私钥文件未上传，请在支付通道配置中上传 seller_rsa_private_key.pem');
}

/**
 * RSA私钥签名 (不转hex)
 */
function rsaSign(data, privateKey) {
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(data);
    return sign.sign(privateKey, 'base64');
}

/**
 * 支付提交
 */
async function submit(channel, order, config, params = {}) {
    const { device } = params;
    const isMobile = device === 'mobile';
    const oriUrl = isMobile ? GATEWAY_H5 : GATEWAY_PC;

    const desKey = channel.appkey;
    const keys = Buffer.from(desKey, 'base64');

    const param = {
        version: 'V2.0',
        merchant: channel.appid,
        tradeNum: order.trade_no,
        tradeName: order.name || '商品',
        tradeTime: new Date().toISOString().replace(/[-:T]/g, '').substring(0, 14),
        amount: String(Math.round(order.realmoney * 100)),
        currency: 'CNY',
        callbackUrl: config.siteurl + 'pay/return/' + order.trade_no + '/',
        notifyUrl: config.localurl + 'pay/notify/' + order.trade_no + '/',
        ip: params.clientip || '127.0.0.1',
        userId: '',
        orderType: '1'
    };

    // 生成签名
    const signStr = getSignString(param, ['sign']);
    const privateKey = loadPrivateKey(channel);
    param.sign = rsaSign(sha256(signStr), privateKey);

    // 加密字段
    const encryptedParam = {
        version: param.version,
        merchant: param.merchant,
        sign: param.sign,
        tradeNum: tdesEncrypt(param.tradeNum, desKey),
        tradeName: param.tradeName ? tdesEncrypt(param.tradeName, desKey) : '',
        tradeTime: tdesEncrypt(param.tradeTime, desKey),
        amount: tdesEncrypt(param.amount, desKey),
        currency: tdesEncrypt(param.currency, desKey),
        callbackUrl: tdesEncrypt(param.callbackUrl, desKey),
        notifyUrl: tdesEncrypt(param.notifyUrl, desKey),
        ip: tdesEncrypt(param.ip, desKey),
        userId: param.userId ? tdesEncrypt(param.userId, desKey) : '',
        orderType: param.orderType ? tdesEncrypt(param.orderType, desKey) : ''
    };

    // 生成HTML表单
    let html = `<form action="${oriUrl}" method="post" id="dopay">`;
    for (const [key, value] of Object.entries(encryptedParam)) {
        if (value !== '') {
            html += `<input type="hidden" name="${key}" value="${value}" />`;
        }
    }
    html += `<input type="submit" value="正在跳转"></form>`;
    html += `<script>document.getElementById("dopay").submit();</script>`;

    return { type: 'html', data: html };
}

/**
 * MAPI接口
 */
async function mapi(channel, order, config, params = {}) {
    return await submit(channel, order, config, params);
}

/**
 * 解析XML
 */
function parseXml(xml) {
    const result = {};
    const tagRegex = /<(\w+)>([^<]*)<\/\1>/g;
    let match;
    while ((match = tagRegex.exec(xml)) !== null) {
        result[match[1]] = match[2];
    }
    return result;
}

/**
 * 异步回调
 */
async function notify(channel, order, params) {
    const { body } = params;

    if (!body) {
        return { success: false, type: 'html', data: 'error' };
    }

    const desKey = channel.appkey;

    try {
        // 解析XML
        const xmlData = typeof body === 'string' ? body : '';
        const parsed = parseXml(xmlData);

        // 解密字段
        if (parsed.tradeNum) {
            parsed.tradeNum = tdesDecrypt(parsed.tradeNum, desKey);
        }
        if (parsed.amount) {
            parsed.amount = tdesDecrypt(parsed.amount, desKey);
        }
        if (parsed.status) {
            parsed.status = tdesDecrypt(parsed.status, desKey);
        }

        if (parsed.status === '2') {
            const outTradeNo = parsed.tradeNum;
            const money = parseInt(parsed.amount) / 100;

            if (outTradeNo === order.trade_no && Math.abs(money - order.realmoney) < 0.01) {
                return {
                    success: true,
                    type: 'html',
                    data: 'success',
                    order: {
                        trade_no: outTradeNo,
                        api_trade_no: outTradeNo
                    }
                };
            }
        }
        return { success: false, type: 'html', data: 'success' };
    } catch (ex) {
        return { success: false, type: 'html', data: 'error' };
    }
}

/**
 * 退款
 */
async function refund(channel, order, config) {
    const desKey = channel.appkey;

    const param = {
        version: 'V2.0',
        merchant: channel.appid,
        tradeNum: order.refund_no,
        oTradeNum: order.api_trade_no,
        amount: String(Math.round(order.refundmoney * 100)),
        currency: 'CNY'
    };

    // 生成签名
    const signStr = getSignString(param, ['sign']);
    const privateKey = loadPrivateKey(channel);
    param.sign = rsaSign(sha256(signStr), privateKey);

    // 生成加密的XML请求
    let xml = '<?xml version="1.0" encoding="UTF-8"?><jdpay>';
    xml += `<version>${param.version}</version>`;
    xml += `<merchant>${param.merchant}</merchant>`;
    xml += `<sign>${param.sign}</sign>`;
    xml += `<tradeNum>${tdesEncrypt(param.tradeNum, desKey)}</tradeNum>`;
    xml += `<oTradeNum>${tdesEncrypt(param.oTradeNum, desKey)}</oTradeNum>`;
    xml += `<amount>${tdesEncrypt(param.amount, desKey)}</amount>`;
    xml += `<currency>${tdesEncrypt(param.currency, desKey)}</currency>`;
    xml += '</jdpay>';

    try {
        const response = await axios.post(GATEWAY_REFUND, xml, {
            headers: { 'Content-Type': 'application/xml' }
        });

        const resXml = response.data;
        const resData = parseXml(resXml);

        // 解密返回数据
        if (resData.status) {
            resData.status = tdesDecrypt(resData.status, desKey);
        }
        if (resData.amount) {
            resData.amount = tdesDecrypt(resData.amount, desKey);
        }
        if (resData.oTradeNum) {
            resData.oTradeNum = tdesDecrypt(resData.oTradeNum, desKey);
        }

        if (resData.status === '1') {
            return {
                code: 0,
                trade_no: resData.oTradeNum,
                refund_fee: parseInt(resData.amount) / 100
            };
        } else {
            return { code: -1, msg: `[${resData.code}]${resData.desc}` };
        }
    } catch (ex) {
        return { code: -1, msg: ex.message };
    }
}

module.exports = {
    info,
    submit,
    mapi,
    notify,
    refund
};
