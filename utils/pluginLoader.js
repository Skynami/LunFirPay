/**
 * 插件加载器（主线程）
 * 自动扫描并加载所有支付插件，支持热更新
 */
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

class PluginLoader {
  constructor() {
    this.plugins = new Map();
    this.pluginsDir = path.join(__dirname, '../plugins');
    this.watcher = null;
  }

  /**
   * 初始化插件加载器
   */
  init() {
    console.log('[Plugin] 初始化插件加载器...');
    this.loadAllPlugins();
    this.watchPlugins();
  }

  /**
   * 加载所有插件
   */
  loadAllPlugins() {
    if (!fs.existsSync(this.pluginsDir)) {
      fs.mkdirSync(this.pluginsDir, { recursive: true });
      console.log('[Plugin] 创建插件目录:', this.pluginsDir);
      return;
    }

    const pluginFolders = fs.readdirSync(this.pluginsDir)
      .filter(file => {
        const stat = fs.statSync(path.join(this.pluginsDir, file));
        return stat.isDirectory();
      });

    pluginFolders.forEach(name => {
      this.loadPlugin(name, false);
    });

    console.log(`[Plugin] 已加载 ${this.plugins.size} 个插件`);
  }

  /**
   * 加载单个插件
   */
  loadPlugin(name, log = true) {
    try {
      const pluginPath = path.join(this.pluginsDir, name, `${name}_plugin.js`);
      
      if (!fs.existsSync(pluginPath)) {
        if (log) console.warn(`[Plugin] 插件文件不存在: ${pluginPath}`);
        return false;
      }

      // 清除缓存以支持热加载
      delete require.cache[require.resolve(pluginPath)];
      
      const plugin = require(pluginPath);
      
      if (!plugin.info || !plugin.info.name) {
        if (log) console.warn(`[Plugin] 插件 ${name} 缺少必要的 info 信息`);
        return false;
      }

      this.plugins.set(name, plugin);
      if (log) console.log(`[Plugin] 加载成功: ${plugin.info.showname || name}`);
      return true;
    } catch (error) {
      if (log) console.error(`[Plugin] 加载 ${name} 失败:`, error.message);
      return false;
    }
  }

  /**
   * 卸载插件
   */
  unloadPlugin(name) {
    if (this.plugins.has(name)) {
      this.plugins.delete(name);
      console.log(`[Plugin] 卸载: ${name}`);
    }
  }

  /**
   * 重新加载插件
   */
  reloadPlugin(name) {
    this.unloadPlugin(name);
    return this.loadPlugin(name);
  }

  /**
   * 监听插件目录变化（热加载）
   */
  watchPlugins() {
    this.watcher = chokidar.watch(this.pluginsDir, {
      ignored: /node_modules/,
      persistent: true,
      depth: 2
    });

    this.watcher
      .on('change', (filePath) => {
        const relativePath = path.relative(this.pluginsDir, filePath);
        const pluginName = relativePath.split(path.sep)[0];
        
        if (filePath.endsWith('_plugin.js')) {
          console.log(`[Plugin] 检测到文件变化: ${pluginName}`);
          setTimeout(() => this.reloadPlugin(pluginName), 100);
        }
      })
      .on('addDir', (dirPath) => {
        const relativePath = path.relative(this.pluginsDir, dirPath);
        if (!relativePath.includes(path.sep)) {
          const pluginName = relativePath;
          setTimeout(() => this.loadPlugin(pluginName), 500);
        }
      })
      .on('unlinkDir', (dirPath) => {
        const relativePath = path.relative(this.pluginsDir, dirPath);
        if (!relativePath.includes(path.sep)) {
          const pluginName = relativePath;
          this.unloadPlugin(pluginName);
        }
      });

    console.log('[Plugin] 热加载监听已启动');
  }

  /**
   * 获取插件
   */
  getPlugin(name) {
    return this.plugins.get(name);
  }

  /**
   * 获取所有插件列表
   */
  getPluginList() {
    const list = [];
    this.plugins.forEach((plugin, name) => {
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
    });
    
    list.sort((a, b) => a.name.localeCompare(b.name));
    return list;
  }

  /**
   * 调用插件方法
   */
  async callPluginMethod(pluginName, methodName, ...args) {
    const plugin = this.getPlugin(pluginName);
    if (!plugin) {
      throw new Error(`插件不存在: ${pluginName}`);
    }
    if (typeof plugin[methodName] !== 'function') {
      throw new Error(`插件方法不存在: ${pluginName}.${methodName}`);
    }
    return await plugin[methodName](...args);
  }

  /**
   * 停止监听
   */
  stopWatching() {
    if (this.watcher) {
      this.watcher.close();
      console.log('[Plugin] 监听已停止');
    }
  }
}

// 单例
const pluginLoader = new PluginLoader();

module.exports = pluginLoader;
