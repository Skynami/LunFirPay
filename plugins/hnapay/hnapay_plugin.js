/**
 * 新生支付插件
 * RSA签名 + RSA加密
 * https://www.hnapay.com/
 */
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const certValidator = require('../../utils/certValidator');

const info = {
    name: 'hnapay',
    showname: '新生支付',
    author: '新生支付',
    link: 'https://www.hnapay.com/',
    types: ['alipay', 'wxpay', 'bank'],
    transtypes: ['bank'],
    inputs: {
        appid: {
            name: '商户ID',
            type: 'input',
            note: '新生用户ID'
        },
        appkey: {
            name: '新生公钥(新收款密钥)',
            type: 'textarea',
            note: ''
        },
        appsecret: {
            name: '商户私钥(新收款密钥)',
            type: 'textarea',
            note: ''
        },
        appmchid: {
            name: '报备编号',
            type: 'input',
            note: '仅支付宝&微信需要填写'
        },
        appswitch: {
            name: '接口类型',
            type: 'select',
            options: { '0': '公众号/生活号支付', '1': '支付宝H5', '2': '扫码支付' }
        }
    },
    select: null,
    certs: [
        { key: 'mchKey', name: '收款密钥', ext: '.pem', desc: 'mch.key（扫码支付需要）', optional: true },
        { key: 'payKey', name: '付款密钥', ext: '.pem', desc: 'pay.key（付款功能需要）', optional: true }
    ],
    note: '需要使用RSA密钥！<br/>【可选】如使用扫码支付，请上传收款密钥mch.key；如使用付款功能，请上传付款密钥pay.key',
    bindwxmp: true,
    bindwxa: true
};

// API网关
const GATEWAY_SCAN = 'https://gateway.hnapay.com/website/scanPay.do';
const GATEWAY_JSAPI = 'https://gateway.hnapay.com/ita/inCharge.do';
const GATEWAY_H5 = 'https://gateway.hnapay.com/multipay/h5.do';
const GATEWAY_REFUND = 'https://gateway.hnapay.com/exp/refund.do';
const GATEWAY_QUERY = 'https://gateway.hnapay.com/exp/query.do';

/**
 * 获取证书绝对路径
 */
function getCertAbsolutePath(channel, certKey) {
    let config = channel.config;
    if (typeof config === 'string') {
        try { config = JSON.parse(config); } catch (e) { return null; }
    }
    const certFilename = config?.certs?.[certKey]?.filename;
    if (!certFilename) return null;
    return certValidator.getAbsolutePath(certFilename);
}

/**
 * 获取私钥（优先使用证书文件，否则使用配置字符串）
 */
function getPrivateKey(channel, certKeyName = 'mchKey', fallbackKey = 'appsecret') {
    // 优先使用证书文件
    const certPath = getCertAbsolutePath(channel, certKeyName);
    if (certPath && fs.existsSync(certPath)) {
        return fs.readFileSync(certPath, 'utf8');
    }
    // 回退到配置字符串
    return channel[fallbackKey];
}

/**
 * 格式化私钥
 */
function formatPrivateKey(privateKey) {
    if (privateKey.includes('-----BEGIN')) return privateKey;
    return `-----BEGIN RSA PRIVATE KEY-----\n${privateKey.replace(/(.{64})/g, '$1\n').trim()}\n-----END RSA PRIVATE KEY-----`;
}

/**
 * 格式化公钥
 */
function formatPublicKey(publicKey) {
    if (publicKey.includes('-----BEGIN')) return publicKey;
    return `-----BEGIN PUBLIC KEY-----\n${publicKey.replace(/(.{64})/g, '$1\n').trim()}\n-----END PUBLIC KEY-----`;
}

/**
 * RSA私钥签名
 */
function rsaPrivateSign(data, privateKey, isHex = false) {
    const sign = crypto.createSign('RSA-SHA1');
    sign.update(data);
    const signature = sign.sign(formatPrivateKey(privateKey));
    return isHex ? signature.toString('hex') : signature.toString('base64');
}

/**
 * RSA公钥验签
 */
function rsaPublicVerify(data, signature, publicKey, isHex = false) {
    const verify = crypto.createVerify('RSA-SHA1');
    verify.update(data);
    const signBuffer = isHex ? Buffer.from(signature, 'hex') : Buffer.from(signature, 'base64');
    return verify.verify(formatPublicKey(publicKey), signBuffer);
}

/**
 * RSA公钥加密
 */
function rsaPublicEncrypt(data, publicKey) {
    const key = formatPublicKey(publicKey);
    const dataBuffer = Buffer.from(data, 'utf8');
    const chunks = [];
    const chunkSize = 117; // RSA 1024位密钥最大加密长度
    
    for (let i = 0; i < dataBuffer.length; i += chunkSize) {
        const chunk = dataBuffer.slice(i, i + chunkSize);
        const encrypted = crypto.publicEncrypt(
            { key, padding: crypto.constants.RSA_PKCS1_PADDING },
            chunk
        );
        chunks.push(encrypted);
    }
    
    return Buffer.concat(chunks).toString('base64');
}

/**
 * 生成签名字符串 (新格式)
 */
function getSignContent(params, signOrder) {
    const parts = [];
    for (const key of signOrder) {
        let value = params[key];
        if (value === undefined) value = '';
        if (typeof value === 'object') {
            value = JSON.stringify(value);
        }
        parts.push(`${key}=[${value}]`);
    }
    return parts.join('');
}

/**
 * 生成签名字符串 (旧格式)
 */
function getSignContentOld(params, signOrder) {
    const parts = [];
    for (const key of signOrder) {
        let value = params[key];
        if (value === undefined) value = '';
        parts.push(`${key}=${value}`);
    }
    return parts.join('&');
}

/**
 * 加密请求参数
 */
function encryptParams(params, publicKey) {
    const data = JSON.stringify(params);
    return rsaPublicEncrypt(data, publicKey);
}

/**
 * 扫码支付下单
 */
async function scanPay(channel, order, config, clientip, orgCode) {
    const params = {
        tranCode: 'WS01',
        version: '2.1',
        merId: channel.appid,
        payType: 'QRCODE_B2C',
        charset: '1',
        signType: '1',
        merOrderNum: order.trade_no,
        tranAmt: String(Math.round(order.realmoney * 100)),
        submitTime: order.trade_no.substring(0, 14),
        orgCode: orgCode,
        goodsName: order.name || '商品',
        tranIP: clientip,
        notifyUrl: config.localurl + 'pay/notifys/' + order.trade_no + '/',
        weChatMchId: channel.appmchid || ''
    };

    // 扫码支付使用收款密钥 (mchKey)
    const privateKey = getPrivateKey(channel, 'mchKey', 'appsecret');
    const signOrder = ['tranCode', 'version', 'merId', 'submitTime', 'merOrderNum', 'tranAmt', 'payType', 'orgCode', 'notifyUrl', 'charset', 'signType'];
    params.signMsg = rsaPrivateSign(getSignContentOld(params, signOrder), privateKey, true);

    const response = await axios.post(GATEWAY_SCAN, new URLSearchParams(params).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const result = response.data;
    if (result.resultCode === '0000') {
        // 提取二维码URL
        let qrCodeUrl = result.qrCodeUrl;
        if (qrCodeUrl && qrCodeUrl.includes('qrContent=')) {
            const match = qrCodeUrl.match(/qrContent=([^&]+)/);
            if (match) qrCodeUrl = decodeURIComponent(match[1]);
        }
        return qrCodeUrl;
    } else {
        throw new Error(`[${result.resultCode}]${result.msgExt || '下单失败'}`);
    }
}

/**
 * JSAPI支付下单
 */
async function jsapiPay(channel, order, config, clientip, orgCode, appId, openId) {
    const bizParams = {
        tranAmt: order.realmoney,
        orgCode: orgCode,
        notifyServerUrl: config.localurl + 'pay/notify/' + order.trade_no + '/',
        merUserIp: clientip,
        goodsInfo: order.name || '商品',
        orderSubject: order.name || '商品',
        merchantId: channel.appmchid || ''
    };

    if (orgCode === 'WECHATPAY') {
        bizParams.appId = appId;
        bizParams.openId = openId;
    } else if (orgCode === 'ALIPAY') {
        bizParams.aliAppId = appId;
        bizParams.buyerId = openId;
    }

    const params = {
        version: '2.0',
        tranCode: 'ITA10',
        merId: channel.appid,
        merOrderId: order.trade_no,
        submitTime: order.trade_no.substring(0, 14),
        signType: '1',
        charset: '1',
        msgCiphertext: encryptParams(bizParams, channel.appkey)
    };

    const signOrder = ['version', 'tranCode', 'merId', 'merOrderId', 'submitTime', 'msgCiphertext'];
    params.signValue = rsaPrivateSign(getSignContent(params, signOrder), channel.appsecret);

    const response = await axios.post(GATEWAY_JSAPI, new URLSearchParams(params).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const result = response.data;
    if (result.resultCode === '0000') {
        return result.payInfo;
    } else {
        throw new Error(`[${result.errorCode}]${result.errorMsg || '下单失败'}`);
    }
}

/**
 * 支付提交
 */
async function submit(channel, order, config, params = {}) {
    if (order.typename === 'alipay') {
        if (channel.appswitch === '0') {
            return { type: 'jump', url: '/pay/alipayjs/' + order.trade_no + '/?d=1' };
        } else if (channel.appswitch === '1') {
            return { type: 'jump', url: '/pay/alipayh5/' + order.trade_no + '/' };
        } else {
            return { type: 'jump', url: '/pay/alipay/' + order.trade_no + '/' };
        }
    } else if (order.typename === 'wxpay') {
        if (channel.appswitch === '0' && channel.appwxmp > 0) {
            return { type: 'jump', url: '/pay/wxjspay/' + order.trade_no + '/?d=1' };
        } else if (channel.appswitch === '0' && channel.appwxa > 0) {
            return { type: 'jump', url: '/pay/wxwappay/' + order.trade_no + '/' };
        } else {
            return { type: 'jump', url: '/pay/wxpay/' + order.trade_no + '/' };
        }
    } else if (order.typename === 'bank') {
        return { type: 'jump', url: '/pay/bank/' + order.trade_no + '/' };
    }
}

/**
 * MAPI接口
 */
async function mapi(channel, order, config, params = {}) {
    const { device, clientip, method } = params;

    if (channel.appswitch === '0' && method === 'jsapi') {
        if (order.typename === 'alipay') {
            return await alipayjs(channel, order, config, clientip, params);
        } else if (order.typename === 'wxpay') {
            return await wxjspay(channel, order, config, clientip, params);
        }
    }

    if (order.typename === 'alipay') {
        if (channel.appswitch === '1' && device === 'mobile') {
            return await alipayh5(channel, order, config, clientip, params);
        }
        return await alipay(channel, order, config, clientip, device);
    } else if (order.typename === 'wxpay') {
        if (channel.appswitch === '0' && device === 'mobile' && channel.appwxa > 0) {
            return await wxwappay(channel, order, config, params);
        }
        return await wxpay(channel, order, config, clientip, device);
    } else if (order.typename === 'bank') {
        return await bank(channel, order, config, clientip);
    }
}

/**
 * 支付宝扫码支付
 */
async function alipay(channel, order, config, clientip, device) {
    let codeUrl;
    if (channel.appswitch === '2') {
        try {
            codeUrl = await scanPay(channel, order, config, clientip, 'ALIPAY');
        } catch (ex) {
            return { type: 'error', msg: '支付宝下单失败！' + ex.message };
        }
    } else if (channel.appswitch === '1') {
        if (device === 'mobile') {
            return await alipayh5(channel, order, config, clientip, {});
        }
        codeUrl = config.siteurl + 'pay/alipayh5/' + order.trade_no + '/?d=1';
    } else {
        codeUrl = config.siteurl + 'pay/alipayjs/' + order.trade_no + '/';
    }
    return { type: 'qrcode', page: 'alipay_qrcode', url: codeUrl };
}

/**
 * 支付宝JS支付
 */
async function alipayjs(channel, order, config, clientip, params = {}) {
    const { method, userId, alipayChannel } = params;

    if (!userId) {
        return { type: 'error', msg: '未获取到支付宝用户ID' };
    }

    try {
        const appId = alipayChannel ? alipayChannel.appid : '';
        const retData = await jsapiPay(channel, order, config, clientip, 'ALIPAY', appId, userId);

        if (method === 'jsapi') {
            return { type: 'jsapi', data: retData.tradeNO };
        }

        return {
            type: 'page',
            page: 'alipay_jspay',
            data: { alipay_trade_no: retData.tradeNO }
        };
    } catch (ex) {
        return { type: 'error', msg: '支付宝下单失败！' + ex.message };
    }
}

/**
 * 支付宝H5支付
 */
async function alipayh5(channel, order, config, clientip, params = {}) {
    const frontUrl = config.siteurl + 'pay/return/' + order.trade_no + '/';

    const bizParams = {
        tranAmt: order.realmoney,
        payType: 'HnaZFB',
        exPayMode: '',
        cardNo: '',
        holderName: '',
        identityCode: '',
        merUserId: '',
        orderExpireTime: '10',
        frontUrl: frontUrl,
        notifyUrl: config.localurl + 'pay/notify/' + order.trade_no + '/',
        riskExpand: '',
        goodsInfo: '',
        orderSubject: order.name || '商品',
        orderDesc: '',
        merchantId: JSON.stringify({ '02': channel.appmchid }),
        bizProtocolNo: '',
        payProtocolNo: '',
        merUserIp: clientip,
        payLimit: ''
    };

    const requestParams = {
        version: '2.0',
        tranCode: 'MUP11',
        merId: channel.appid,
        merOrderId: order.trade_no,
        submitTime: order.trade_no.substring(0, 14),
        signType: '1',
        charset: '1',
        msgCiphertext: encryptParams(bizParams, channel.appkey)
    };

    const signOrder = ['version', 'tranCode', 'merId', 'merOrderId', 'submitTime', 'signType', 'charset', 'msgCiphertext'];
    requestParams.signValue = rsaPrivateSign(getSignContent(requestParams, signOrder), channel.appsecret);

    // 生成HTML表单
    let html = `<form id='alipaysubmit' name='alipaysubmit' action='${GATEWAY_H5}' method='POST'>`;
    for (const [key, value] of Object.entries(requestParams)) {
        const escapedValue = String(value).replace(/"/g, '&quot;');
        html += `<input type='hidden' name='${key}' value='${escapedValue}'/>`;
    }
    html += `<input type='submit' value='ok' style='display:none;'></form>`;
    html += `<script>document.forms['alipaysubmit'].submit();</script>`;

    return { type: 'html', data: html };
}

/**
 * 微信扫码支付
 */
async function wxpay(channel, order, config, clientip, device) {
    let codeUrl;
    if (channel.appswitch === '2') {
        try {
            codeUrl = await scanPay(channel, order, config, clientip, 'WECHATPAY');
        } catch (ex) {
            return { type: 'error', msg: '微信支付下单失败！' + ex.message };
        }
    } else {
        codeUrl = config.siteurl + 'pay/wxjspay/' + order.trade_no + '/';
    }

    if (device === 'mobile') {
        return { type: 'qrcode', page: 'wxpay_wap', url: codeUrl };
    } else {
        return { type: 'qrcode', page: 'wxpay_qrcode', url: codeUrl };
    }
}

/**
 * 微信公众号支付
 */
async function wxjspay(channel, order, config, clientip, params = {}) {
    const { method, openid, wxinfo } = params;

    if (!openid || !wxinfo) {
        return { type: 'error', msg: '未获取到用户openid' };
    }

    try {
        const payInfo = await jsapiPay(channel, order, config, clientip, 'WECHATPAY', wxinfo.appid, openid);

        if (method === 'jsapi') {
            return { type: 'jsapi', data: JSON.stringify(payInfo) };
        }

        return {
            type: 'page',
            page: 'wxpay_jspay',
            data: { jsApiParameters: JSON.stringify(payInfo) }
        };
    } catch (ex) {
        return { type: 'error', msg: '微信支付下单失败！' + ex.message };
    }
}

/**
 * 微信手机支付(小程序跳转)
 */
async function wxwappay(channel, order, config, params = {}) {
    return { type: 'error', msg: '请绑定微信小程序后使用' };
}

/**
 * 云闪付扫码支付
 */
async function bank(channel, order, config, clientip) {
    try {
        const codeUrl = await scanPay(channel, order, config, clientip, 'UNIONPAY');
        return { type: 'qrcode', page: 'bank_qrcode', url: codeUrl };
    } catch (ex) {
        return { type: 'error', msg: '银联云闪付下单失败！' + ex.message };
    }
}

/**
 * 异步回调
 */
async function notify(channel, order, params) {
    const { body, query } = params;

    let notifyData = {};
    if (body && typeof body === 'object') {
        notifyData = body;
    } else if (body && typeof body === 'string') {
        const urlParams = new URLSearchParams(body);
        for (const [key, value] of urlParams) {
            notifyData[key] = value;
        }
    }
    if (query) {
        Object.assign(notifyData, query);
    }

    // 验签
    let verifyResult = false;
    if (notifyData.tranCode === 'MUP11') {
        // 支付宝H5回调验签
        const signOrder = ['version', 'tranCode', 'merOrderId', 'merId', 'charset', 'signType', 'resultCode', 'hnapayOrderId'];
        const signStr = getSignContent(notifyData, signOrder);
        verifyResult = rsaPublicVerify(signStr, notifyData.signValue, channel.appkey);
    } else if (notifyData.tranCode === 'EXP13') {
        // 快捷支付回调验签
        const signOrder = ['version', 'tranCode', 'merOrderId', 'merId', 'charset', 'signType', 'resultCode', 'errorCode', 'hnapayOrderId', 'bizProtocolNo', 'payProtocolNo', 'tranAmt', 'checkDate', 'bankCode', 'cardType', 'shortCardNo'];
        const signStr = getSignContent(notifyData, signOrder);
        verifyResult = rsaPublicVerify(signStr, notifyData.signValue, channel.appkey);
    } else if (notifyData.signValue) {
        // JSAPI回调验签
        const signOrder = ['version', 'tranCode', 'merOrderId', 'merId', 'merAttach', 'charset', 'signType', 'hnapayOrderId', 'resultCode', 'tranAmt', 'submitTime', 'tranFinishTime'];
        const signStr = getSignContent(notifyData, signOrder);
        verifyResult = rsaPublicVerify(signStr, notifyData.signValue, channel.appkey);
    }

    if (verifyResult && notifyData.resultCode === '0000') {
        const outTradeNo = notifyData.merOrderId;
        const tradeNo = notifyData.hnapayOrderId;
        const billMchTradeNo = notifyData.bankOrderId || '';
        let billTradeNo = notifyData.realBankOrderId || '';
        const buyer = notifyData.userId || '';

        // 处理银行订单号格式
        if (order.type === 1 && billTradeNo.length > 4) {
            const year = new Date().getFullYear().toString();
            if (billTradeNo.substring(0, 4) !== year && billTradeNo.substring(2, 6) === year) {
                billTradeNo = billTradeNo.substring(2);
            }
        }

        if (outTradeNo === order.trade_no) {
            return {
                success: true,
                type: 'html',
                data: '200',
                order: {
                    trade_no: outTradeNo,
                    api_trade_no: tradeNo,
                    buyer: buyer,
                    bill_trade_no: billTradeNo,
                    bill_mch_trade_no: billMchTradeNo
                }
            };
        }
        return { success: false, type: 'html', data: '200' };
    }

    return { success: false, type: 'html', data: 'sign_error' };
}

/**
 * 扫码支付异步回调
 */
async function notifys(channel, order, params) {
    const { body, query } = params;

    let notifyData = {};
    if (body && typeof body === 'object') {
        notifyData = body;
    } else if (body && typeof body === 'string') {
        const urlParams = new URLSearchParams(body);
        for (const [key, value] of urlParams) {
            notifyData[key] = value;
        }
    }
    if (query) {
        Object.assign(notifyData, query);
    }

    // 扫码支付回调验签
    const signOrder = ['tranCode', 'version', 'merId', 'merOrderNum', 'tranAmt', 'submitTime', 'hnapayOrderId', 'tranFinishTime', 'respCode', 'charset', 'signType'];
    const signStr = getSignContentOld(notifyData, signOrder);
    const verifyResult = rsaPublicVerify(signStr, notifyData.signMsg, channel.appkey, true);

    if (verifyResult && notifyData.respCode === '0000') {
        const outTradeNo = notifyData.merOrderNum;
        const tradeNo = notifyData.hnapayOrderId;
        const billMchTradeNo = notifyData.bankOrderId || '';
        let billTradeNo = notifyData.realBankOrderId || '';
        const buyer = notifyData.userId || '';

        if (order.type === 1 && billTradeNo.length > 4) {
            const year = new Date().getFullYear().toString();
            if (billTradeNo.substring(0, 4) !== year && billTradeNo.substring(2, 6) === year) {
                billTradeNo = billTradeNo.substring(2);
            }
        }

        if (outTradeNo === order.trade_no) {
            return {
                success: true,
                type: 'html',
                data: '200',
                order: {
                    trade_no: outTradeNo,
                    api_trade_no: tradeNo,
                    buyer: buyer,
                    bill_trade_no: billTradeNo,
                    bill_mch_trade_no: billMchTradeNo
                }
            };
        }
        return { success: false, type: 'html', data: '200' };
    }

    return { success: false, type: 'html', data: 'sign_error' };
}

/**
 * 退款
 */
async function refund(channel, order, config) {
    const bizParams = {
        orgMerOrderId: order.trade_no,
        orgSubmitTime: order.trade_no.substring(0, 14),
        orderAmt: order.realmoney,
        refundOrderAmt: order.refundmoney,
        notifyUrl: config.localurl + 'pay/refundnotify/' + order.refund_no + '/'
    };

    const params = {
        version: '2.0',
        tranCode: 'EXP09',
        merId: channel.appid,
        merOrderId: order.refund_no,
        submitTime: new Date().toISOString().replace(/[-:T]/g, '').substring(0, 14),
        signType: '1',
        charset: '1',
        msgCiphertext: encryptParams(bizParams, channel.appkey)
    };

    const signOrder = ['version', 'tranCode', 'merId', 'merOrderId', 'submitTime', 'msgCiphertext'];
    params.signValue = rsaPrivateSign(getSignContent(params, signOrder), channel.appsecret);

    try {
        const response = await axios.post(GATEWAY_REFUND, new URLSearchParams(params).toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const result = response.data;
        if (result.resultCode === '0000') {
            return {
                code: 0,
                trade_no: result.orgMerOrderId,
                refund_fee: result.refundAmt
            };
        } else {
            return { code: -1, msg: `[${result.errorCode}]${result.errorMsg}` };
        }
    } catch (ex) {
        return { code: -1, msg: ex.message };
    }
}

/**
 * 转账
 */
async function transfer(channel, bizParam, config) {
    const GATEWAY_TRANSFER = 'https://gateway.hnapay.com/website/singlePay.do';

    const bizParams = {
        tranAmt: bizParam.money,
        payType: '1',
        auditFlag: '0',
        payeeName: bizParam.payee_real_name,
        payeeAccount: bizParam.payee_account,
        note: '',
        remark: bizParam.transfer_desc || '',
        bankCode: '',
        payeeType: '1',
        notifyUrl: config.localurl + 'pay/transfernotify/' + channel.id + '/',
        paymentTerminalInfo: '01|A10001',
        deviceInfo: bizParam.clientip || '127.0.0.1'
    };

    const params = {
        version: '2.1',
        tranCode: 'SGP01',
        merId: channel.appid,
        merOrderId: bizParam.out_biz_no,
        submitTime: new Date().toISOString().replace(/[-:T]/g, '').substring(0, 14),
        signType: '1',
        charset: '1',
        msgCiphertext: encryptParams(bizParams, channel.appkey)
    };

    const signOrder = ['version', 'tranCode', 'merId', 'merOrderId', 'submitTime', 'msgCiphertext', 'signType'];
    params.signValue = rsaPrivateSign(getSignContent(params, signOrder), channel.appsecret);

    try {
        const response = await axios.post(GATEWAY_TRANSFER, new URLSearchParams(params).toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const result = response.data;
        if (result.resultCode === '0000') {
            return {
                code: 0,
                status: 0,
                orderid: result.hnapayOrderId,
                paydate: new Date().toISOString().slice(0, 19).replace('T', ' ')
            };
        } else {
            return { code: -1, msg: `[${result.errorCode}]${result.errorMsg}` };
        }
    } catch (ex) {
        return { code: -1, msg: ex.message };
    }
}

/**
 * 转账查询
 */
async function transferQuery(channel, bizParam) {
    const GATEWAY_TRANSFER_QUERY = 'https://gateway.hnapay.com/website/singlePayQuery.do';

    const params = {
        version: '2.0',
        tranCode: 'SGP02',
        merOrderId: bizParam.out_biz_no,
        submitTime: bizParam.out_biz_no.substring(0, 14),
        signType: '1',
        charset: '1'
    };

    const signOrder = ['version', 'tranCode', 'merId', 'merOrderId', 'submitTime'];
    params.signValue = rsaPrivateSign(getSignContent(params, signOrder), channel.appsecret);

    try {
        const response = await axios.post(GATEWAY_TRANSFER_QUERY, new URLSearchParams(params).toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const result = response.data;
        if (result.resultCode === '0000') {
            let status;
            let errmsg = '';
            if (result.orderStatus === '1') {
                status = 1;
            } else if (result.orderStatus === '0' || result.orderStatus === '3') {
                status = 0;
            } else {
                status = 2;
            }
            if (result.orderFailedCode) {
                errmsg = `[${result.orderFailedCode}]${result.orderFailedMsg}`;
            }
            return {
                code: 0,
                status: status,
                amount: result.tranAmt,
                paydate: result.successTime ? new Date(result.successTime).toISOString().slice(0, 19).replace('T', ' ') : '',
                errmsg: errmsg
            };
        } else {
            return { code: -1, msg: `[${result.errorCode}]${result.errorMsg}` };
        }
    } catch (ex) {
        return { code: -1, msg: ex.message };
    }
}

/**
 * 余额查询
 */
async function balanceQuery(channel) {
    const GATEWAY_BALANCE = 'https://gateway.hnapay.com/merchant/acct/queryBalance.do';

    const params = {
        version: '2.0',
        tranCode: 'QB01',
        merId: channel.appid,
        acctType: '11',
        signType: '1',
        charset: '1'
    };

    const signOrder = ['version', 'tranCode', 'merId', 'acctType', 'charset', 'signType'];
    params.signValue = rsaPrivateSign(getSignContent(params, signOrder), channel.appsecret);

    try {
        const response = await axios.post(GATEWAY_BALANCE, new URLSearchParams(params).toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const result = response.data;
        if (result.resultCode === '0000') {
            return {
                code: 0,
                amount: result.avaBalance,
                msg: `当前账户可用余额：${result.avaBalance} 元，待结转金额：${result.pendAmt}`
            };
        } else {
            return { code: -1, msg: `[${result.errorCode}]${result.errorMsg}` };
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
    notifys,
    refund,
    transfer,
    transferQuery,
    balanceQuery,
    alipay,
    alipayjs,
    alipayh5,
    wxpay,
    wxjspay,
    wxwappay,
    bank
};
