import { EventEmitter } from 'events';
import net from 'net';

// RadioRA2 Platform Shim for HomeBridge
//
// Remember to add platform to config.json. Example:
// 'platforms': [
//     {
//         'platform': 'RadioRA',             // required
//         'name': 'RadioRA',                 // required
//     }
// ],
//
// When you attempt to add a device, it will ask for a 'PIN code'.
// The default code for all HomeBridge accessories is 031-45-154.
//

const MESSAGE_RECEIVED = 'messageReceived';

const priv = Symbol();
let Service;
let Characteristic;

function incomingData(context, str) {
  try {
    if (/GNET>\s/.test(str)) {
      if (!context.loggedIn) {
        context.log('Logged into RadioRA controller');
        context.loggedIn = context.ready = true;
        context.ra.emit('loggedIn', true);
      }
      while (context.commandQueue.length) {
        const msg = context.commandQueue.shift();
        context.socket.write(msg);
      }
      return;
    }
    const m = /^~OUTPUT,(\d+),1,([\d\.]+)/.exec(str);
    if (m) {
      const deviceId = Number(m[1]);
      context.status[deviceId] = context.status[deviceId] || {};
      context.status[deviceId].level = m[2];
      delete context.status[deviceId].inProcess;
      context.ra.emit(MESSAGE_RECEIVED, {
        type: 'status',
        id: deviceId,
        level: m[2],
      });
    }
  } catch (error) {
    context.log(error.message);
  }
}

function sendPassword(context, prompt) {
  if (!/^password:\s*/.test(prompt)) {
    context.log(`Bad login response /${prompt}/`);
    return;
  }
  
  context.state = incomingData;
  context.socket.write(`${context.config.password}\r\n`);
}

function sendUsername(context, prompt) {
  if (!/^login:\s*/.test(prompt)) {
    context.log(`Bad initial response /${prompt}/`);
    return;
  }
  context.socket.write(`${context.config.username}\r\n`);
  context.state = sendPassword;
}

let dogs = 0;

/**
 * Make sure fn gets called exactly once after no more than maxTime
 */
function watchDog(name, maxTime, context, fn) {
  const start = Date.now();
  dogs++;
  let wasDone = false;
  setTimeout(() => {
    if (!wasDone) {
      wasDone = true;
      dogs--;
      context.log(`${name} watch dog told to lay down after ${maxTime} (${dogs})`);
      fn();
    }
  }, maxTime);
  return (...cbArgs) => {
    const time = Date.now() - start;
    if (!wasDone) {
      wasDone = true;
      dogs--;
      context.log(`${name} completed in ${time}ms (${dogs})`);
      fn(...cbArgs);
    } else {
      context.log(`${name} callback took too long ${time}ms (${dogs})`);
    }
  };
}

class RadioRAItem {
  constructor(log, item, platform) {
    // device info
    this.name = item.name;
    this.lastPosition = 100;
    this.model = 'RadioRA';
    this.deviceId = item.id;
    this.serial = item.serial;
    this.log = log;
    this.platform = platform;
  }

  getPosition(callback) {
    this.platform[priv].log(`getPosition for device ${this.deviceId}`);

    this.platform.getPosition(this.deviceId,
      watchDog('getPosition', this.platform[priv].timeout, this.platform[priv],
        (level) => {
          this.log(`getPosition for device ${this.deviceId} is ${Math.ceil(level)}`)
          callback(null, Math.ceil(level));
        }));
  }
  setPosition(level, callback) {
    this.platform[priv].log(`setPosition for device ${this.deviceId} to ${level}%`);

    this.platform.setPosition(
      this.deviceId, 
      level,
      watchDog('setPosition', this.platform[priv].timeout, this.platform[priv], (response) => {
        if (response) {
          callback(null, Math.ceil(response.level));
        }
        else {
          this.platform[priv].log('setPosition received no response data');
          
          // Attempt to get the new position
          this.getPosition(callback);
        }
      })
    );
  }

  getServices() {
    const services = [];
    this.service = new Service.WindowCovering(this.name);
    this.service.RadioRAItem = this;

    this.service.getCharacteristic(Characteristic.CurrentPosition)
      .on('get', (callback) => {
        this.getPosition(callback);
      });
      
    this.service.getCharacteristic(Characteristic.TargetPosition)
      .on('get', (callback) => {
        this.getPosition(callback);
      })
      .on('set', (value, callback) => {
        this.setPosition(value, callback);
      });
    
    //Characteristic.PositionState never seemed to be called for anything
    
    services.push(this.service);

    const service = new Service.AccessoryInformation();
    service.setCharacteristic(Characteristic.Manufacturer, 'LUTRON')
      .setCharacteristic(Characteristic.Model, this.model)
      .setCharacteristic(Characteristic.SerialNumber, this.serial);
    services.push(service);

    return services;
  }
}

class RadioRA extends EventEmitter {
  constructor(log, config) {
    super();
    this.setMaxListeners(0);
    log('RadioRA Platform Created');
    this[priv] = {
      ra: this,
      config,
      log,
      ready: false,
      loggedIn: false,
      socket: null,
      state: null,
      commandQueue: [],
      responderQueue: [],
      status: {},
      timeout: config.timeout || 4000,
    };
    this.connect();
    module.exports.platforms[config.name || 'default'] = this;
  }

  connect() {
    const p = this[priv];
    p.state = sendUsername;

    p.socket = net.connect(23, this[priv].config.host);
    p.socket.on('data', (data) => {
      const str = String(data);
      const parts = str.split('\r\n');
      for (const line of parts) {
        p.state(p, line);
      }
    }).on('connect', () => {
      p.log('Connected to RadioRA controller');
    }).on('end', () => {
      if (this[priv].loggedIn) {
        p.log('Lost connection to RadioRA controller, reconnecting');
        p.loggedIn = p.ready = false;
        this.connect();
      } else {
        p.log('Connection to RadioRA controller ended');
      }
    });
  }

  disconnect() {
    this[priv].loggedIn = false;
    this[priv].socket.end();
  }

  sendCommand(command) {
    const p = this[priv];
    let toSend = command;
    
    if (!/\r\n$/.test(toSend)) {
      toSend += '\r\n';
    }

    if (p.ready) {
      p.socket.write(toSend);
    } else {
      p.log.debug('Controller not ready, adding command to queue...');
      p.commandQueue.push(toSend);
    }
  }

  setPosition(id, level, maybeFade, maybeDelay, maybeCallback) {
    let cb = maybeCallback;
    let delay = maybeDelay;
    let fade = maybeFade;
    
    if (!cb) { cb = delay; delay = null; }
    if (!cb) { cb = fade; fade = null; }

    const result = (msg) => {
      if (msg.type === 'status' && id === msg.id) {
        if (cb) {
          cb(msg);
        }
        this.removeListener(MESSAGE_RECEIVED, result);
      }
    };
    this.on(MESSAGE_RECEIVED, result);

    // TODO: From map. See Lutron's "OUTPUT: Command Summary" in the integration protocol PDF.
    const action = 1; // Set or Get Zone Level

    let cmd = `#OUTPUT,${id},${action},${level}`;
    if (fade) {
      cmd += `,${fade}`;
      if (delay) {
        cmd += `,${delay}`;
      }
    }
    
    this.sendCommand(cmd);
  }

  getPosition(id, callback) {
    const numId = Number(id);
    const p = this[priv];
    
    p.status[numId] = p.status[numId] || {};
    
    const result = (msg) => {
      if (msg.type === 'status' && numId === msg.id) {
        this.removeListener(MESSAGE_RECEIVED, result);
        callback(parseFloat(msg.level));
      }
    };

    this.on(MESSAGE_RECEIVED, result);

    if (!p.status[numId].inProcess) {
      p.status[numId].inProcess = true;
      const cmd = `?OUTPUT,${numId}`;
      this.sendCommand(cmd);
    } else {
      p.log(`Waiting for existing query for status of ${id}`);
    }
  }

  accessories(callback) {
    const items = [];

    this[priv].log('Fetching RadioRA shades from HomeBridge config...');
    
    for (let i = 0; i < this[priv].config.shades.length; i++) {
      const rrItem = new RadioRAItem(this[priv].log, this[priv].config.shades[i], this);
      items.push(rrItem);
      this.accessories[this[priv].config.shades[i].id] = rrItem;
    }

    callback(items);
  }
}

function Homebridge(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;

  homebridge.registerAccessory('homebridge-radiora-item', 'RadioRAItem', RadioRAItem);
  homebridge.registerPlatform('homebridge-radiora', 'RadioRA', RadioRA);
}

Homebridge.accessory = RadioRAItem;
Homebridge.platform = RadioRA;
Homebridge.platforms = {};

module.exports = Homebridge;
