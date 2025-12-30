/**
 * 微信官方支付服务商版插件
 * 使用APIv2接口
 * 移植自PHP版本
 */

const crypto = require('crypto');
const axios = require('axios');
const xml2js = require('xml2js');
const fs = require('fs');
const path = require('path');
const certValidator = require('../../utils/certValidator');

// 插件信息
const info = {
    name: 'wxpaysl',
    showname: '微信官方支付服务商版',
    author: '微信',
    link: 'https://pay.weixin.qq.com/partner/public/home',
    types: ['wxpay'],
    inputs: {
        appid: {
            name: '服务号/小程序/开放平台AppID',
            type: 'input',
            note: ''
        },
        appmchid: {
            name: '商户号',
            type: 'input',
            note: ''
        },
        appkey: {
            name: '商户API密钥',
            type: 'input',
            note: 'APIv2密钥'
        },
        appurl: {
            name: '子商户号',
            type: 'input',
            note: ''
        }
    },
    select: {
        '1': 'Native支付',
        '2': 'JSAPI支付',
        '3': 'H5支付',
        '5': 'APP支付'
    },
    certs: [
        { key: 'clientCert', name: '商户证书', ext: '.pem', desc: 'apiclient_cert.pem（退款需要）', optional: true },
        { key: 'privateCert', name: '商户私钥', ext: '.pem', desc: 'apiclient_key.pem（退款需要）', optional: true }
    ],
    note: '<p>下方AppID填写已认证的服务号/小程序/开放平台应用皆可，需要在微信支付后台关联对应的AppID账号才能使用。</p><p>【可选】如需退款功能，请上传API证书</p>',
    bindwxmp: true,
    bindwxa: true
};

const API_BASE = 'https://api.mch.weixin.qq.com';

/**
 * 生成随机字符串
 */
function generateNonceStr(length = 32) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

/**
 * MD5签名
 */
function md5Sign(str) {
    return crypto.createHash('md5').update(str, 'utf8').digest('hex').toUpperCase();
}

/**
 * 生成签名
 */
function generateSign(params, apiKey) {
    const sortedKeys = Object.keys(params).sort();
    const signParts = [];
    
    for (const key of sortedKeys) {
        const value = params[key];
        if (key !== 'sign' && value !== undefined && value !== null && value !== '') {
            signParts.push(`${key}=${value}`);
        }
    }
    
    const signString = signParts.join('&') + `&key=${apiKey}`;
    return md5Sign(signString);
}

/**
 * 验证签名
 */
function verifySign(params, apiKey) {
    const sign = params.sign;
    delete params.sign;
    const mySign = generateSign(params, apiKey);
    return sign === mySign;
}

/**
 * 对象转XML
 */
function buildXml(obj) {
    const builder = new xml2js.Builder({ headless: true, rootName: 'xml', cdata: true });
    return builder.buildObject(obj);
}

/**
 * XML转对象
 */
async function parseXml(xmlString) {
    const parser = new xml2js.Parser({ explicitArray: false, ignoreAttrs: true });
    const result = await parser.parseStringPromise(xmlString);
    return result.xml;
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
 * 发送请求到微信
 */
async function sendRequest(apiUrl, params, channelConfig, useCert = false) {
    const xmlData = buildXml(params);
    
    const axiosConfig = {
        method: 'POST',
        url: `${API_BASE}${apiUrl}`,
        data: xmlData,
        headers: { 'Content-Type': 'text/xml' }
    };
    
    // 如果需要证书
    if (useCert) {
        const certFile = getCertAbsolutePath(channelConfig, 'clientCert');
        const keyFile = getCertAbsolutePath(channelConfig, 'privateCert');
        
        if (certFile && keyFile && fs.existsSync(certFile) && fs.existsSync(keyFile)) {
            const https = require('https');
            axiosConfig.httpsAgent = new https.Agent({
                cert: fs.readFileSync(certFile),
                key: fs.readFileSync(keyFile)
            });
        }
    }
    
    const response = await axios(axiosConfig);
    return await parseXml(response.data);
}

/**
 * 构建通用请求参数
 */
function buildRequestParams(config, params) {
    const baseParams = {
        appid: config.appid,
        mch_id: config.appmchid,
        sub_mch_id: config.appurl,
        nonce_str: generateNonceStr(),
        ...params
    };
    
    baseParams.sign = generateSign(baseParams, config.appkey);
    return baseParams;
}

/**
 * 检查是否配置了有效的微信公众号绑定
 */
function hasWxmp(channelConfig) {
    return channelConfig.wxmp && channelConfig.wxmp.appid && channelConfig.wxmp.appsecret;
}

/**
 * 检查是否配置了有效的微信小程序绑定
 */
function hasWxa(channelConfig) {
    return channelConfig.wxa && channelConfig.wxa.appid && channelConfig.wxa.appsecret;
}

/**
 * 发起支付
 */
async function submit(channelConfig, orderInfo, conf) {
    const { trade_no, is_wechat, is_mobile } = orderInfo;
    const apptype = channelConfig.apptype || [];
    
    if (is_wechat) {
        // 微信浏览器内
        if (apptype.includes('2') && hasWxmp(channelConfig)) {
            // 配置了公众号，可以使用 JSAPI
            return { type: 'jump', url: `/pay/jspay/${trade_no}/?d=1` };
        } else if (apptype.includes('2') && hasWxa(channelConfig)) {
            // 配置了小程序，跳转到 wap 页面（小程序跳转）
            return { type: 'jump', url: `/pay/wap/${trade_no}/` };
        } else if (apptype.includes('1')) {
            // 只支持 Native 扫码
            return { type: 'jump', url: `/pay/qrcode/${trade_no}/` };
        }
        // 无法在微信内支付，显示提交页面
        return { type: 'jump', url: `/pay/submit/${trade_no}/` };
    } else if (is_mobile) {
        // 手机浏览器
        if (apptype.includes('3')) {
            // H5 支付
            return { type: 'jump', url: `/pay/h5/${trade_no}/` };
        } else if (apptype.includes('5')) {
            // APP 支付
            return { type: 'jump', url: `/pay/apppay/${trade_no}/` };
        } else if (apptype.includes('2') && (hasWxmp(channelConfig) || hasWxa(channelConfig))) {
            // 有绑定公众号或小程序，跳转到 wap 页面
            return { type: 'jump', url: `/pay/wap/${trade_no}/` };
        }
        // 默认扫码
        return { type: 'jump', url: `/pay/qrcode/${trade_no}/` };
    }
    
    // PC端，默认扫码
    return { type: 'jump', url: `/pay/qrcode/${trade_no}/` };
}

/**
 * MAPI支付
 */
async function mapi(channelConfig, orderInfo, conf) {
    const { method, device, mdevice, trade_no } = orderInfo;
    const apptype = channelConfig.apptype || [];
    const siteurl = conf.siteurl || '';
    
    if (method === 'app') {
        return await apppay(channelConfig, orderInfo, conf);
    } else if (method === 'jsapi') {
        return await jspay(channelConfig, orderInfo, conf);
    } else if (method === 'scan') {
        return await scanpay(channelConfig, orderInfo, conf);
    } else if (mdevice === 'wechat') {
        // 微信客户端内
        if (apptype.includes('2') && hasWxmp(channelConfig)) {
            // 有公众号绑定，使用 JSAPI
            return { type: 'jump', url: `${siteurl}pay/jspay/${trade_no}/?d=1` };
        } else if (apptype.includes('2') && hasWxa(channelConfig)) {
            // 有小程序绑定，跳转 wap
            return await wap(channelConfig, orderInfo, conf);
        }
        return { type: 'jump', url: `${siteurl}pay/submit/${trade_no}/` };
    } else if (device === 'mobile') {
        // 手机浏览器
        if (apptype.includes('3')) {
            return await h5pay(channelConfig, orderInfo, conf);
        } else if (apptype.includes('5')) {
            return { type: 'jump', url: `${siteurl}pay/submit/${trade_no}/` };
        } else if (apptype.includes('2') && (hasWxmp(channelConfig) || hasWxa(channelConfig))) {
            return await wap(channelConfig, orderInfo, conf);
        }
        return await qrcode(channelConfig, orderInfo, conf);
    } else {
        return await qrcode(channelConfig, orderInfo, conf);
    }
}

/**
 * Native扫码支付
 */
async function qrcode(channelConfig, orderInfo, conf) {
    const { trade_no, money, name, notify_url, is_wechat, clientip } = orderInfo;
    const apptype = channelConfig.apptype || [];
    const siteurl = conf.siteurl || '';
    
    // 如果没有开启 Native 但开启了 JSAPI 且有公众号/小程序绑定
    if (!apptype.includes('1') && apptype.includes('2') && hasWxmp(channelConfig)) {
        return { type: 'qrcode', url: `${siteurl}pay/jspay/${trade_no}/` };
    } else if (!apptype.includes('1') && apptype.includes('2') && hasWxa(channelConfig)) {
        return { type: 'qrcode', url: `${siteurl}pay/wap/${trade_no}/` };
    } else if (!apptype.includes('1')) {
        throw new Error('当前支付通道没有开启的支付方式');
    }
    
    const params = buildRequestParams(channelConfig, {
        body: name,
        out_trade_no: trade_no,
        total_fee: Math.round(money * 100).toString(),
        spbill_create_ip: clientip || '127.0.0.1',
        notify_url: notify_url,
        trade_type: 'NATIVE',
        product_id: '01001'
    });
    
    const result = await sendRequest('/pay/unifiedorder', params, channelConfig);
    
    if (result.return_code !== 'SUCCESS') {
        throw new Error(result.return_msg || '微信支付下单失败');
    }
    
    if (result.result_code !== 'SUCCESS') {
        throw new Error(result.err_code_des || result.err_code || '微信支付下单失败');
    }
    
    const code_url = result.code_url;
    
    if (is_wechat) {
        return { type: 'jump', url: code_url };
    }
    
    return { type: 'qrcode', url: code_url };
}

/**
 * 手机支付（显示微信扫码或小程序跳转）
 */
async function wap(channelConfig, orderInfo, conf) {
    const { trade_no } = orderInfo;
    const siteurl = conf.siteurl || '';
    
    if (hasWxa(channelConfig)) {
        // 有小程序绑定，生成小程序跳转链接
        // TODO: 实现小程序 URL Scheme 生成
        const code_url = `${siteurl}pay/jspay/${trade_no}/`;
        return { type: 'qrcode', url: code_url };
    } else {
        // 只有公众号，显示 JSAPI 扫码
        const code_url = `${siteurl}pay/jspay/${trade_no}/`;
        return { type: 'qrcode', url: code_url };
    }
}

/**
 * H5支付
 */
async function h5pay(channelConfig, orderInfo, conf) {
    const { trade_no, money, name, notify_url, return_url, clientip } = orderInfo;
    const siteurl = conf.siteurl || '';
    const sitename = conf.sitename || '';
    
    const scene_info = JSON.stringify({
        h5_info: {
            type: 'Wap',
            wap_url: siteurl,
            wap_name: sitename
        }
    });
    
    const params = buildRequestParams(channelConfig, {
        body: name,
        out_trade_no: trade_no,
        total_fee: Math.round(money * 100).toString(),
        spbill_create_ip: clientip || '127.0.0.1',
        notify_url: notify_url,
        trade_type: 'MWEB',
        scene_info: scene_info
    });
    
    const result = await sendRequest('/pay/unifiedorder', params, channelConfig);
    
    if (result.return_code !== 'SUCCESS') {
        throw new Error(result.return_msg || '微信支付下单失败');
    }
    
    if (result.result_code !== 'SUCCESS') {
        throw new Error(result.err_code_des || result.err_code || '微信支付下单失败');
    }
    
    let mweb_url = result.mweb_url;
    if (return_url) {
        mweb_url += `&redirect_url=${encodeURIComponent(return_url)}`;
    }
    
    return { type: 'jump', url: mweb_url };
}

/**
 * JSAPI支付
 */
async function jspay(channelConfig, orderInfo, conf) {
    const { trade_no, money, name, notify_url, openid, method, clientip } = orderInfo;
    
    if (!openid) {
        return { type: 'error', msg: '需要获取用户openid' };
    }
    
    // 对于服务商模式，如果配置了绑定的公众号，需要使用 sub_openid 和 sub_appid
    const requestParams = {
        body: name,
        out_trade_no: trade_no,
        total_fee: Math.round(money * 100).toString(),
        spbill_create_ip: clientip || '127.0.0.1',
        notify_url: notify_url,
        trade_type: 'JSAPI'
    };
    
    // 如果绑定了公众号，使用 sub_appid 和 sub_openid
    if (hasWxmp(channelConfig)) {
        requestParams.sub_appid = channelConfig.wxmp.appid;
        requestParams.sub_openid = openid;
    } else {
        requestParams.openid = openid;
    }
    
    const params = buildRequestParams(channelConfig, requestParams);
    
    const result = await sendRequest('/pay/unifiedorder', params, channelConfig);
    
    if (result.return_code !== 'SUCCESS') {
        throw new Error(result.return_msg || '微信支付下单失败');
    }
    
    if (result.result_code !== 'SUCCESS') {
        throw new Error(result.err_code_des || result.err_code || '微信支付下单失败');
    }
    
    // 生成JSAPI调起参数
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonceStr = generateNonceStr();
    
    // 使用绑定的公众号 appid（如果有），否则使用返回的 appid
    const jsAppId = hasWxmp(channelConfig) ? channelConfig.wxmp.appid : result.appid;
    
    const jsapiParams = {
        appId: jsAppId,
        timeStamp: timestamp,
        nonceStr: nonceStr,
        package: `prepay_id=${result.prepay_id}`,
        signType: 'MD5'
    };
    
    jsapiParams.paySign = generateSign(jsapiParams, channelConfig.appkey);
    
    // 统一返回 jsapi 类型，由前端/路由处理显示
    return { 
        type: 'jsapi', 
        data: jsapiParams,
        redirect_url: `/pay/ok/${trade_no}/`
    };
}

/**
 * APP支付
 */
async function apppay(channelConfig, orderInfo, conf) {
    const { trade_no, money, name, notify_url, method, clientip } = orderInfo;
    
    const params = buildRequestParams(channelConfig, {
        body: name,
        out_trade_no: trade_no,
        total_fee: Math.round(money * 100).toString(),
        spbill_create_ip: clientip || '127.0.0.1',
        notify_url: notify_url,
        trade_type: 'APP'
    });
    
    const result = await sendRequest('/pay/unifiedorder', params, channelConfig);
    
    if (result.return_code !== 'SUCCESS') {
        throw new Error(result.return_msg || '微信支付下单失败');
    }
    
    if (result.result_code !== 'SUCCESS') {
        throw new Error(result.err_code_des || result.err_code || '微信支付下单失败');
    }
    
    // 生成APP调起参数
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonceStr = generateNonceStr();
    
    const appParams = {
        appid: result.appid,
        partnerid: result.mch_id,
        prepayid: result.prepay_id,
        package: 'Sign=WXPay',
        noncestr: nonceStr,
        timestamp: timestamp
    };
    
    appParams.sign = generateSign(appParams, channelConfig.appkey);
    
    if (method === 'app') {
        return { type: 'app', data: appParams };
    }
    
    const code_url = `weixin://app/${result.appid}/pay/?nonceStr=${nonceStr}&package=${appParams.package}&partnerId=${appParams.partnerid}&prepayId=${result.prepay_id}&timeStamp=${timestamp}&sign=${appParams.sign}`;
    return { type: 'qrcode', page: 'wxpay_h5', url: code_url };
}

/**
 * 付款码支付
 */
async function scanpay(channelConfig, orderInfo, conf) {
    const { trade_no, money, name, notify_url, auth_code, clientip } = orderInfo;
    
    const params = buildRequestParams(channelConfig, {
        body: name,
        out_trade_no: trade_no,
        total_fee: Math.round(money * 100).toString(),
        spbill_create_ip: clientip || '127.0.0.1',
        auth_code: auth_code
    });
    
    const result = await sendRequest('/pay/micropay', params, channelConfig);
    
    if (result.return_code !== 'SUCCESS') {
        throw new Error(result.return_msg || '微信支付失败');
    }
    
    if (result.result_code === 'SUCCESS') {
        return {
            type: 'scan',
            data: {
                type: orderInfo.typename,
                trade_no: result.out_trade_no,
                api_trade_no: result.transaction_id,
                buyer: result.openid,
                money: (parseInt(result.total_fee) / 100).toFixed(2)
            }
        };
    } else if (result.err_code === 'USERPAYING' || result.err_code === 'SYSTEMERROR') {
        throw new Error('支付处理中，请稍后查询');
    } else {
        throw new Error(result.err_code_des || result.err_code || '支付失败');
    }
}

/**
 * 验证异步通知
 */
async function notify(channelConfig, notifyData, order, headers) {
    try {
        // 解析XML
        let data;
        if (typeof notifyData === 'string') {
            data = await parseXml(notifyData);
        } else {
            data = notifyData;
        }
        
        // 验证签名
        if (!verifySign({ ...data }, channelConfig.appkey)) {
            console.log('微信服务商版回调验签失败');
            return { success: false };
        }
        
        if (data.return_code !== 'SUCCESS' || data.result_code !== 'SUCCESS') {
            return { success: false };
        }
        
        if (data.out_trade_no !== order.trade_no) {
            return { success: false };
        }
        
        if (parseInt(data.total_fee) !== Math.round(order.real_money * 100)) {
            return { success: false };
        }
        
        return {
            success: true,
            api_trade_no: data.transaction_id,
            buyer: data.openid
        };
    } catch (error) {
        console.error('微信服务商版回调处理错误:', error);
        return { success: false };
    }
}

/**
 * 退款
 */
async function refund(channelConfig, refundInfo) {
    const { trade_no, api_trade_no, refund_money, total_money, refund_no } = refundInfo;
    
    const params = buildRequestParams(channelConfig, {
        transaction_id: api_trade_no,
        out_refund_no: refund_no,
        total_fee: Math.round(total_money * 100).toString(),
        refund_fee: Math.round(refund_money * 100).toString()
    });
    
    const result = await sendRequest('/secapi/pay/refund', params, channelConfig, true);
    
    if (result.return_code !== 'SUCCESS') {
        throw new Error(result.return_msg || '退款失败');
    }
    
    if (result.result_code !== 'SUCCESS') {
        throw new Error(result.err_code_des || result.err_code || '退款失败');
    }
    
    return {
        code: 0,
        trade_no: result.transaction_id,
        refund_fee: (parseInt(result.refund_fee) / 100).toFixed(2)
    };
}

/**
 * 关闭订单
 */
async function close(channelConfig, order) {
    const params = buildRequestParams(channelConfig, {
        out_trade_no: order.trade_no
    });
    
    const result = await sendRequest('/pay/closeorder', params, channelConfig);
    
    if (result.return_code !== 'SUCCESS') {
        throw new Error(result.return_msg || '关闭订单失败');
    }
    
    if (result.result_code !== 'SUCCESS' && result.err_code !== 'ORDERCLOSED') {
        throw new Error(result.err_code_des || result.err_code || '关闭订单失败');
    }
    
    return { code: 0 };
}

module.exports = {
    info,
    submit,
    mapi,
    qrcode,
    wap,
    h5pay,
    jspay,
    apppay,
    scanpay,
    notify,
    refund,
    close
};
