'use strict';

const fs = require('node:fs/promises');
const path = require('path');
const debug = require('debug')('WireGuard');
const crypto = require('node:crypto');
const QRCode = require('qrcode');
const CRC32 = require('crc-32');
const ip = require('ip');

const Util = require('./Util');
const ServerError = require('./ServerError');

const {
  WG_PATH,
  WG_HOST,
  WG_PORT,
  WG_CONFIG_PORT,
  WG_MTU,
  WG_DEFAULT_DNS,
  WG_DEFAULT_ADDRESS,
  WG_PERSISTENT_KEEPALIVE,
  WG_ALLOWED_IPS,
  WG_PRE_UP,
  WG_POST_UP,
  WG_PRE_DOWN,
  WG_POST_DOWN,
  WG_ENABLE_EXPIRES_TIME,
  WG_ENABLE_ONE_TIME_LINKS,
} = require('../config');

module.exports = class WireGuard {

  async __buildConfig() {
    this.__configPromise = Promise.resolve().then(async () => {
      if (!WG_HOST) {
        throw new Error('WG_HOST Environment Variable Not Set!');
      }

      debug('Loading configuration...');
      let config;
      try {
        config = await fs.readFile(path.join(WG_PATH, 'wg0.json'), 'utf8');
        config = JSON.parse(config);
        debug('Configuration loaded.');
      } catch (err) {
        const privateKey = await Util.exec('wg genkey');
        const publicKey = await Util.exec(`echo ${privateKey} | wg pubkey`, {
          log: 'echo ***hidden*** | wg pubkey',
        });
        const cidr = ip.cidrSubnet(WG_DEFAULT_ADDRESS);
        const firstAddress = cidr.firstAddress;
        config = {
          server: {
            privateKey,
            publicKey,
            firstAddress,
          },
          clients: {},
        };
        debug('Configuration generated.');
      }

      return config;
    });

    return this.__configPromise;
  }

  async getConfig() {
    if (!this.__configPromise) {
      const config = await this.__buildConfig();

      await this.__saveConfig(config);
      await Util.exec('wg-quick down wg0').catch(() => {});
      await Util.exec('wg-quick up wg0').catch((err) => {
        if (err && err.message && err.message.includes('Cannot find device "wg0"')) {
          throw new Error('WireGuard exited with the error: Cannot find device "wg0"\nThis usually means that your host\'s kernel does not support WireGuard!');
        }

        throw err;
      });
      // await Util.exec(`iptables -t nat -A POSTROUTING -s ${WG_DEFAULT_ADDRESS.replace('x', '0')}/24 -o ' + WG_DEVICE + ' -j MASQUERADE`);
      // await Util.exec('iptables -A INPUT -p udp -m udp --dport 51820 -j ACCEPT');
      // await Util.exec('iptables -A FORWARD -i wg0 -j ACCEPT');
      // await Util.exec('iptables -A FORWARD -o wg0 -j ACCEPT');
      await this.__syncConfig();
    }

    return this.__configPromise;
  }

  async saveConfig() {
    const config = await this.getConfig();
    await this.__saveConfig(config);
    await this.__syncConfig();
  }

  async __saveConfig(config) {
    let result = `
# Note: Do not edit this file directly.
# Your changes will be overwritten!

# Server
[Interface]
PrivateKey = ${config.server.privateKey}
Address = ${config.server.address}
ListenPort = ${WG_PORT}
PreUp = ${WG_PRE_UP}
PostUp = ${WG_POST_UP}
PreDown = ${WG_PRE_DOWN}
PostDown = ${WG_POST_DOWN}
`;

    for (const [clientId, client] of Object.entries(config.clients)) {
      if (!client.enabled) continue;

      result += `

# Client: ${client.name} (${clientId})
[Peer]
PublicKey = ${client.publicKey}
${client.preSharedKey ? `PresharedKey = ${client.preSharedKey}\n` : ''
}AllowedIPs = ${client.address}/32`;
    }

    debug('Config saving...');
    await fs.writeFile(path.join(WG_PATH, 'wg0.json'), JSON.stringify(config, false, 2), {
      mode: 0o660,
    });
    await fs.writeFile(path.join(WG_PATH, 'wg0.conf'), result, {
      mode: 0o600,
    });
    debug('Config saved.');
  }

  async __syncConfig() {
    debug('Config syncing...');
    await Util.exec('wg syncconf wg0 <(wg-quick strip wg0)');
    debug('Config synced.');
  }

  async getClients() {
    const config = await this.getConfig();
    const clients = Object.entries(config.clients).map(([clientId, client]) => ({
      id: clientId,
      name: client.name,
      enabled: client.enabled,
      address: client.address,
      publicKey: client.publicKey,
      createdAt: new Date(client.createdAt),
      updatedAt: new Date(client.updatedAt),
      expiredAt: client.expiredAt !== null
        ? new Date(client.expiredAt)
        : null,
      allowedIPs: client.allowedIPs,
      oneTimeLink: client.oneTimeLink ?? null,
      oneTimeLinkExpiresAt: client.oneTimeLinkExpiresAt ?? null,
      downloadableConfig: 'privateKey' in client,
      persistentKeepalive: null,
      latestHandshakeAt: null,
      transferRx: null,
      transferTx: null,
      endpoint: null,
    }));

    // Loop WireGuard status
    const dump = await Util.exec('wg show wg0 dump', {
      log: false,
    });
    dump
      .trim()
      .split('\n')
      .slice(1)
      .forEach((line) => {
        const [
          publicKey,
          preSharedKey, // eslint-disable-line no-unused-vars
          endpoint, // eslint-disable-line no-unused-vars
          allowedIps, // eslint-disable-line no-unused-vars
          latestHandshakeAt,
          transferRx,
          transferTx,
          persistentKeepalive,
        ] = line.split('\t');

        const client = clients.find((client) => client.publicKey === publicKey);
        if (!client) return;

        client.latestHandshakeAt = latestHandshakeAt === '0'
          ? null
          : new Date(Number(`${latestHandshakeAt}000`));
        client.endpoint = endpoint === '(none)' ? null : endpoint;
        client.transferRx = Number(transferRx);
        client.transferTx = Number(transferTx);
        client.persistentKeepalive = persistentKeepalive;
      });

    return clients;
  }

  async getClient({ clientId }) {
    const config = await this.getConfig();
    const client = config.clients[clientId];
    if (!client) {
      throw new ServerError(`Client Not Found: ${clientId}`, 404);
    }

    return client;
  }

  async getClientConfiguration({ clientId }) {
    const config = await this.getConfig();
    const client = await this.getClient({ clientId });

    return `
[Interface]
PrivateKey = ${client.privateKey ? `${client.privateKey}` : 'REPLACE_ME'}
Address = ${client.address}
${WG_DEFAULT_DNS ? `DNS = ${WG_DEFAULT_DNS}\n` : ''}\
${WG_MTU ? `MTU = ${WG_MTU}\n` : ''}\

[Peer]
PublicKey = ${config.server.publicKey}
${client.preSharedKey ? `PresharedKey = ${client.preSharedKey}\n` : ''
}AllowedIPs = ${WG_ALLOWED_IPS}
PersistentKeepalive = ${WG_PERSISTENT_KEEPALIVE}
Endpoint = ${WG_HOST}:${WG_CONFIG_PORT}`;
  }

  async getClientQRCodeSVG({ clientId }) {
    const config = await this.getClientConfiguration({ clientId });
    return QRCode.toString(config, {
      type: 'svg',
      width: 512,
    });
  }

  async createClient({ name, expiredDate }) {
    if (!name) {
      throw new Error('Missing: Name');
    }

    const config = await this.getConfig();

    const privateKey = await Util.exec('wg genkey');
    const publicKey = await Util.exec(`echo ${privateKey} | wg pubkey`, {
      log: 'echo ***hidden*** | wg pubkey',
    });
    const preSharedKey = await Util.exec('wg genpsk');

    // Calculate next IP
    const cidr = ip.cidrSubnet(WG_DEFAULT_ADDRESS);
    let address;
    for (
      let i = ip.toLong(cidr.firstAddress) + 1;
      i <= ip.toLong(cidr.lastAddress) - 1;
      i++
    ) {
      const currentIp = ip.fromLong(i);
      const client = Object.values(clients).find((client) => {
        return client.address === currentIp;
      });

      if (!client) {
        address = currentIp;
        break;
      }
    }

    if (!address) {
      throw new Error('Maximum number of clients reached.');
    }
    // Create Client
    const id = crypto.randomUUID();
    const client = {
      id,
      name,
      address,
      privateKey,
      publicKey,
      preSharedKey,

      createdAt: new Date(),
      updatedAt: new Date(),
      expiredAt: null,
      enabled: true,
    };
    if (expiredDate) {
      client.expiredAt = new Date(expiredDate);
      client.expiredAt.setHours(23);
      client.expiredAt.setMinutes(59);
      client.expiredAt.setSeconds(59);
    }
    config.clients[id] = client;

    await this.saveConfig();

    return client;
  }

  async deleteClient({ clientId }) {
    const config = await this.getConfig();

    if (config.clients[clientId]) {
      delete config.clients[clientId];
      await this.saveConfig();
    }
  }

  async enableClient({ clientId }) {
    const client = await this.getClient({ clientId });

    client.enabled = true;
    client.updatedAt = new Date();

    await this.saveConfig();
  }

  async generateOneTimeLink({ clientId }) {
    const client = await this.getClient({ clientId });
    const key = `${clientId}-${Math.floor(Math.random() * 1000)}`;
    client.oneTimeLink = Math.abs(CRC32.str(key)).toString(16);
    client.oneTimeLinkExpiresAt = new Date(Date.now() + 5 * 60 * 1000);
    client.updatedAt = new Date();
    await this.saveConfig();
  }

  async eraseOneTimeLink({ clientId }) {
    const client = await this.getClient({ clientId });
    // client.oneTimeLink = null;
    client.oneTimeLinkExpiresAt = new Date(Date.now() + 10 * 1000);
    client.updatedAt = new Date();
    await this.saveConfig();
  }

  async disableClient({ clientId }) {
    const client = await this.getClient({ clientId });

    client.enabled = false;
    client.updatedAt = new Date();

    await this.saveConfig();
  }

  async updateClientName({ clientId, name }) {
    const client = await this.getClient({ clientId });

    client.name = name;
    client.updatedAt = new Date();

    await this.saveConfig();
  }

  async updateClientAddress({ clientId, address }) {
    const client = await this.getClient({ clientId });

    if (!ip.isV4Format(address)) {
      throw new ServerError(`Invalid Address: ${address}`, 400);
    }

    client.address = address;
    client.updatedAt = new Date();

    await this.saveConfig();
  }

  async updateClientExpireDate({ clientId, expireDate }) {
    const client = await this.getClient({ clientId });

    if (expireDate) {
      client.expiredAt = new Date(expireDate);
      client.expiredAt.setHours(23);
      client.expiredAt.setMinutes(59);
      client.expiredAt.setSeconds(59);
    } else {
      client.expiredAt = null;
    }
    client.updatedAt = new Date();

    await this.saveConfig();
  }

  async __reloadConfig() {
    await this.__buildConfig();
    await this.__syncConfig();
  }

  async restoreConfiguration(config) {
    debug('Starting configuration restore process.');
    const _config = JSON.parse(config);
    await this.__saveConfig(_config);
    await this.__reloadConfig();
    debug('Configuration restore process completed.');
  }

  async backupConfiguration() {
    debug('Starting configuration backup.');
    const config = await this.getConfig();
    const backup = JSON.stringify(config, null, 2);
    debug('Configuration backup completed.');
    return backup;
  }

  // Shutdown wireguard
  async Shutdown() {
    await Util.exec('wg-quick down wg0').catch(() => {});
  }

  async cronJobEveryMinute() {
    const config = await this.getConfig();
    let needSaveConfig = false;
    // Expires Feature
    if (WG_ENABLE_EXPIRES_TIME === 'true') {
      for (const client of Object.values(config.clients)) {
        if (client.enabled !== true) continue;
        if (client.expiredAt !== null && new Date() > new Date(client.expiredAt)) {
          debug(`Client ${client.id} expired.`);
          needSaveConfig = true;
          client.enabled = false;
          client.updatedAt = new Date();
        }
      }
    }
    // One Time Link Feature
    if (WG_ENABLE_ONE_TIME_LINKS === 'true') {
      for (const client of Object.values(config.clients)) {
        if (client.oneTimeLink !== null && new Date() > new Date(client.oneTimeLinkExpiresAt)) {
          debug(`Client ${client.id} One Time Link expired.`);
          needSaveConfig = true;
          client.oneTimeLink = null;
          client.oneTimeLinkExpiresAt = null;
          client.updatedAt = new Date();
        }
      }
    }
    if (needSaveConfig) {
      await this.saveConfig();
    }
  }

  async getMetrics() {
    const clients = await this.getClients();
    let wireguardPeerCount = 0;
    let wireguardEnabledPeersCount = 0;
    let wireguardConnectedPeersCount = 0;
    let wireguardSentBytes = '';
    let wireguardReceivedBytes = '';
    let wireguardLatestHandshakeSeconds = '';
    for (const client of Object.values(clients)) {
      wireguardPeerCount++;
      if (client.enabled === true) {
        wireguardEnabledPeersCount++;
      }
      if (client.endpoint !== null) {
        wireguardConnectedPeersCount++;
      }
      wireguardSentBytes += `wireguard_sent_bytes{interface="wg0",enabled="${client.enabled}",address="${client.address}",name="${client.name}"} ${Number(client.transferTx)}\n`;
      wireguardReceivedBytes += `wireguard_received_bytes{interface="wg0",enabled="${client.enabled}",address="${client.address}",name="${client.name}"} ${Number(client.transferRx)}\n`;
      wireguardLatestHandshakeSeconds += `wireguard_latest_handshake_seconds{interface="wg0",enabled="${client.enabled}",address="${client.address}",name="${client.name}"} ${client.latestHandshakeAt ? (new Date().getTime() - new Date(client.latestHandshakeAt).getTime()) / 1000 : 0}\n`;
    }

    let returnText = '# HELP wg-easy and wireguard metrics\n';

    returnText += '\n# HELP wireguard_configured_peers\n';
    returnText += '# TYPE wireguard_configured_peers gauge\n';
    returnText += `wireguard_configured_peers{interface="wg0"} ${Number(wireguardPeerCount)}\n`;

    returnText += '\n# HELP wireguard_enabled_peers\n';
    returnText += '# TYPE wireguard_enabled_peers gauge\n';
    returnText += `wireguard_enabled_peers{interface="wg0"} ${Number(wireguardEnabledPeersCount)}\n`;

    returnText += '\n# HELP wireguard_connected_peers\n';
    returnText += '# TYPE wireguard_connected_peers gauge\n';
    returnText += `wireguard_connected_peers{interface="wg0"} ${Number(wireguardConnectedPeersCount)}\n`;

    returnText += '\n# HELP wireguard_sent_bytes Bytes sent to the peer\n';
    returnText += '# TYPE wireguard_sent_bytes counter\n';
    returnText += `${wireguardSentBytes}`;

    returnText += '\n# HELP wireguard_received_bytes Bytes received from the peer\n';
    returnText += '# TYPE wireguard_received_bytes counter\n';
    returnText += `${wireguardReceivedBytes}`;

    returnText += '\n# HELP wireguard_latest_handshake_seconds UNIX timestamp seconds of the last handshake\n';
    returnText += '# TYPE wireguard_latest_handshake_seconds gauge\n';
    returnText += `${wireguardLatestHandshakeSeconds}`;

    return returnText;
  }

  async getMetricsJSON() {
    const clients = await this.getClients();
    let wireguardPeerCount = 0;
    let wireguardEnabledPeersCount = 0;
    let wireguardConnectedPeersCount = 0;
    for (const client of Object.values(clients)) {
      wireguardPeerCount++;
      if (client.enabled === true) {
        wireguardEnabledPeersCount++;
      }
      if (client.endpoint !== null) {
        wireguardConnectedPeersCount++;
      }
    }
    return {
      wireguard_configured_peers: Number(wireguardPeerCount),
      wireguard_enabled_peers: Number(wireguardEnabledPeersCount),
      wireguard_connected_peers: Number(wireguardConnectedPeersCount),
    };
  }

};
