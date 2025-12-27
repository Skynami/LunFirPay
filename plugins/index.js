/**
 * 插件加载器（主线程）
 * 自动扫描并加载所有支付插件
 */
const fs = require('fs');
const path = require('path');

class PluginLoader {
  constructor() {
    this.plugins = {};
    this.pluginsPath = __dirname;
  }

  /**
   * 加载所有插件
   */
  loadAll() {
    const pluginDirs = fs.readdirSync(this.pluginsPath, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);

    for (const dir of pluginDirs) {
      try {
        this.loadPlugin(dir);
      } catch (e) {
        console.error(`[Plugin] 加载 ${dir} 失败:`, e.message);
      }
    }

    console.log(`[Plugin] 已加载 ${Object.keys(this.plugins).length} 个支付插件`);
    return this.plugins;
  }

  /**
   * 加载单个插件
   */
  loadPlugin(name) {
    const pluginFile = path.join(this.pluginsPath, name, `${name}_plugin.js`);
    
    if (!fs.existsSync(pluginFile)) {
      return null;
    }

    const plugin = require(pluginFile);
    
    if (!plugin.info || !plugin.info.name) {
      throw new Error(`Plugin ${name} missing info.name`);
    }

    this.plugins[plugin.info.name] = plugin;
    return plugin;
  }

  /**
   * 获取插件
   */
  getPlugin(name) {
    if (this.plugins[name]) {
      return this.plugins[name];
    }
    
    // 尝试按需加载
    const pluginDirs = fs.readdirSync(this.pluginsPath, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);
    
    for (const dir of pluginDirs) {
      const pluginFile = path.join(this.pluginsPath, dir, `${dir}_plugin.js`);
      if (fs.existsSync(pluginFile)) {
        try {
          const plugin = require(pluginFile);
          if (plugin.info && plugin.info.name === name) {
            this.plugins[name] = plugin;
            return plugin;
          }
        } catch (e) {
          // 忽略加载错误
        }
      }
    }
    
    return null;
  }

  /**
   * 获取所有插件信息
   */
  getAllPluginInfo() {
    const infos = [];
    for (const name in this.plugins) {
      infos.push(this.plugins[name].info);
    }
    return infos;
  }

  /**
   * 获取支持指定支付类型的插件
   */
  getPluginsByType(payType) {
    const result = [];
    for (const name in this.plugins) {
      const plugin = this.plugins[name];
      if (plugin.info.types && plugin.info.types.includes(payType)) {
        result.push(plugin);
      }
    }
    return result;
  }

  /**
   * 获取支持转账的插件
   */
  getTransferPlugins() {
    const result = [];
    for (const name in this.plugins) {
      const plugin = this.plugins[name];
      if (plugin.info.transtypes && plugin.info.transtypes.length > 0) {
        result.push(plugin);
      }
    }
    return result;
  }

  /**
   * 调用插件方法
   */
  async callPluginMethod(pluginName, methodName, ...args) {
    const plugin = this.getPlugin(pluginName);
    if (!plugin) {
      throw new Error(`Plugin ${pluginName} not found`);
    }

    if (typeof plugin[methodName] !== 'function') {
      throw new Error(`Method ${methodName} not found in plugin ${pluginName}`);
    }

    return await plugin[methodName](...args);
  }

  /**
   * 提交支付
   */
  async submit(pluginName, options) {
    return this.callPluginMethod(pluginName, 'submit', options);
  }

  /**
   * MAPI支付
   */
  async mapi(pluginName, options) {
    return this.callPluginMethod(pluginName, 'mapi', options);
  }

  /**
   * 处理异步回调
   */
  async notify(pluginName, params, channel, order, req) {
    return this.callPluginMethod(pluginName, 'notify', params, channel, order, req);
  }

  /**
   * 处理同步回调
   */
  async return(pluginName, params, channel, order) {
    const plugin = this.getPlugin(pluginName);
    if (!plugin) {
      throw new Error(`Plugin ${pluginName} not found`);
    }

    if (typeof plugin.return === 'function') {
      return await plugin.return(params, channel, order);
    }

    return { type: 'page', page: 'return' };
  }

  /**
   * 退款
   */
  async refund(pluginName, order, channel) {
    return this.callPluginMethod(pluginName, 'refund', order, channel);
  }

  /**
   * 转账
   */
  async transfer(pluginName, channel, bizParam) {
    return this.callPluginMethod(pluginName, 'transfer', channel, bizParam);
  }

  /**
   * 转账查询
   */
  async transferQuery(pluginName, channel, bizParam) {
    const plugin = this.getPlugin(pluginName);
    if (!plugin) {
      throw new Error(`Plugin ${pluginName} not found`);
    }

    if (typeof plugin.transferQuery === 'function') {
      return await plugin.transferQuery(channel, bizParam);
    }

    throw new Error(`Transfer query not supported by plugin ${pluginName}`);
  }

  /**
   * 余额查询
   */
  async balanceQuery(pluginName, channel, bizParam) {
    const plugin = this.getPlugin(pluginName);
    if (!plugin) {
      throw new Error(`Plugin ${pluginName} not found`);
    }

    if (typeof plugin.balanceQuery === 'function') {
      return await plugin.balanceQuery(channel, bizParam);
    }

    throw new Error(`Balance query not supported by plugin ${pluginName}`);
  }

  /**
   * 获取插件列表（用于前端展示）
   */
  getPluginList() {
    const list = [];
    for (const name in this.plugins) {
      const plugin = this.plugins[name];
      const info = plugin.info || {};
      
      // 处理证书配置
      let certs = null;
      if (info.certs && Array.isArray(info.certs)) {
        certs = info.certs.map(cert => ({
          key: cert.key,
          name: cert.name,
          ext: cert.ext,
          desc: cert.desc || '',
          required: cert.required || false,
          optional: cert.optional || false,
          needPassword: cert.needPassword || false
        }));
      }
      
      list.push({
        name: info.name,
        showname: info.showname || info.name,
        author: info.author || '',
        link: info.link || '',
        types: info.types || [],
        transtypes: info.transtypes || [],
        inputs: info.inputs || {},
        select: info.select || null,
        select_alipay: info.select_alipay || null,
        select_wxpay: info.select_wxpay || null,
        select_qqpay: info.select_qqpay || null,
        select_bank: info.select_bank || null,
        certs: certs,
        note: info.note || '',
        bindwxmp: info.bindwxmp || false,
        bindwxa: info.bindwxa || false
      });
    }
    
    list.sort((a, b) => a.name.localeCompare(b.name));
    return list;
  }
}

// 单例
const loader = new PluginLoader();

module.exports = {
  PluginLoader,
  loader,
  loadAll: () => loader.loadAll(),
  getPlugin: (name) => loader.getPlugin(name),
  getAllPluginInfo: () => loader.getAllPluginInfo(),
  getPluginList: () => loader.getPluginList(),
  getPluginsByType: (type) => loader.getPluginsByType(type),
  submit: (name, options) => loader.submit(name, options),
  mapi: (name, options) => loader.mapi(name, options),
  notify: (name, params, channel, order, req) => loader.notify(name, params, channel, order, req),
  return: (name, params, channel, order) => loader.return(name, params, channel, order),
  refund: (name, order, channel) => loader.refund(name, order, channel),
  transfer: (name, channel, bizParam) => loader.transfer(name, channel, bizParam),
  transferQuery: (name, channel, bizParam) => loader.transferQuery(name, channel, bizParam),
  balanceQuery: (name, channel, bizParam) => loader.balanceQuery(name, channel, bizParam)
};
