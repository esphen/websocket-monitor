/* See license.txt for terms of usage */

"use strict";

// Add-on SDK
const options = require("@loader/options");
const { Cc, Cu, Ci } = require("chrome");
const { Class } = require("sdk/core/heritage");
const { Tool } = require("dev/toolbox");
const { defer, resolve, all } = require("sdk/core/promise");
const { prefs }  = require("sdk/simple-prefs");

// Firebug.SDK
const { Trace, TraceError, FBTrace } = require("firebug.sdk/lib/core/trace.js").get(module.id);
const { Rdp } = require("firebug.sdk/lib/core/rdp.js");
const { Locale } = require("firebug.sdk/lib/core/locale.js");
const { Content } = require("firebug.sdk/lib/core/content.js");
const { PanelBase } = require("firebug.sdk/lib/panel-base.js");
const { Menu } = require("firebug.sdk/lib/menu.js");

// WebSocket Monitor
const { WsmActorFront } = require("./wsm-actor.js");

// Platform
const { Services } = Cu.import("resource://gre/modules/Services.jsm", {});

// WS Protocol Parsers
var socketIoParser = require("./socket.io-parser");
var sockJsParser = require("./sockjs-parser.js");
var wampParser = require("./wamp-parser.js");

// Constants
const actorModuleUrl = options.prefixURI + "lib/wsm-actor.js";

/**
 * This object represents a new {@Toolbox} panel. This object is
 * running within the chrome scope and ensures basic Toolbox
 * panel aspects such as a tab in the Toolbox tab-bar, etc.
 *
 * The content of the panel is rendered using an iframe that
 * overlaps the entire space. The iframe is called a 'view' and
 * its content is running in content scope (no chrome privileges).
 * HTML in the view is generated using React+Redux libraries.
 *
 * Communication between the panel and view is done through
 * asynchronous messaging.
 */
const WsmPanel = Class(
/** @lends WsmPanel */
{
  extends: PanelBase,

  label: Locale.$STR("websocketmonitor.panel.label"),
  tooltip: Locale.$STR("websocketmonitor.panel.tip"),
  icon: "chrome://websocketmonitor/skin/tool-websockets.svg",
  url: "./view.html",
  invertIconForLightTheme: true,

  searchable: true,

  /**
   * Executed by the framework when an instance of this panel is created.
   * There is one instance of this panel per {@Toolbox}. The panel is
   * instantiated when selected in the toolbox for the first time.
   */
  initialize: function(options) {
    this.extends.initialize.apply(this, arguments);

    // nsIWebSocketEventService events
    this.onWebSocketCreated = this.onWebSocketCreated.bind(this);
    this.onWebSocketOpened = this.onWebSocketOpened.bind(this);
    this.onWebSocketClosed = this.onWebSocketClosed.bind(this);
    this.onWebSocketMessageAvailable = this.onWebSocketMessageAvailable.bind(this);
    this.onFrameReceived = this.onFrameReceived.bind(this);
    this.onFrameSent = this.onFrameSent.bind(this);

    // Communication with the view
    this.togglePause = this.togglePause.bind(this);

    // Backend events
    this.onTabNavigated = this.onTabNavigated.bind(this);
  },

  destroy: function() {
    this.extends.destroy.apply(this, arguments);

    this.toolbox.target.off("navigate", this.onTabNavigated);
  },

  onReady: function() {
    this.extends.onReady.apply(this, arguments);

    this.toolbox.target.on("navigate", this.onTabNavigated);
  },

  getContentConfig: function(config) {
    var available = Cc["@mozilla.org/websocketevent/service;1"] ? true : false;
    config.wsServiceAvailable = available;
    config.defaultPerspective = prefs["tabularView"] ? "table" : "list";
    return config;
  },

  // Options menu

  getOptionsMenuItems: function() {
    return [
      Menu.optionMenu(prefs,
        "websocketmonitor.option.tabularView",
        "tabularView",
        "websocketmonitor.option.tip.tabularView")
    ];
  },

  // Frontend

  togglePause: function (paused) {
    this.front.togglePause(paused);
  },

  // Backend

  attach: function() {
    if (this.front) {
      return resolve(this.front);
    }

    // Inspector actor registration options.
    let config = {
      prefix: WsmActorFront.prototype.typeName,
      actorClass: "WsmActor",
      frontClass: WsmActorFront,
      moduleUrl: actorModuleUrl
    };

    let deferred = defer();
    let client = this.toolbox.target.client;

    // Register as tab actor.
    Rdp.registerTabActor(client, config).then(({registrar, front}) => {
      this.front = front;

      // Drag-drop listener (events sent from the backend)
      this.front.on("webSocketCreated", this.onWebSocketCreated);
      this.front.on("webSocketOpened", this.onWebSocketOpened);
      this.front.on("webSocketClosed", this.onWebSocketClosed);
      this.front.on("webSocketMessageAvailable", this.onWebSocketMessageAvailable);
      this.front.on("frameReceived", this.onFrameReceived);
      this.front.on("frameSent", this.onFrameSent);

      // xxxHonza: unregister actor on shutdown/disable/uninstall
      // but not on toolbox close.
      this.registrar = registrar;

      deferred.resolve(this.front);
    }, response => {
      console.log("WsmPanel.attach; ERROR " + response, response);
    });

    return deferred.promise;
  },

  detach: function() {
    if (!this.front) {
      return resolve();
    }

    let front = this.front;
    let deferred = defer();
    front.detach().then(response => {
      front.off("webSocketCreated", this.onWebSocketCreated);
      front.off("webSocketOpened", this.onWebSocketOpened);
      front.off("webSocketClosed", this.onWebSocketClosed);
      front.off("webSocketMessageAvailable", this.onWebSocketMessageAvailable);
      front.off("frameReceived", this.onFrameReceived);
      front.off("frameSent", this.onFrameSent);

      deferred.resolve(response);
    });

    this.front = null;

    return deferred.promise;
  },

  onTabNavigated: function() {
    this.postContentMessage("tabNavigated");
  },

  // nsIWebSocketEventService events

  onWebSocketCreated: function(data) {
    this.postContentMessage("webSocketCreated", data);
  },

  onWebSocketOpened: function(data) {
    this.postContentMessage("webSocketOpened", data);
  },

  onWebSocketClosed: function(data) {
    this.postContentMessage("webSocketClosed", data);
  },

  onWebSocketMessageAvailable: function(data) {
  },

  onFrameReceived: function(frame) {
    this.decodePacket(frame, frame.data.payload);
    this.postContentMessage("frameReceived",
      convertFromUnicode(JSON.stringify(frame)));
  },

  onFrameSent: function(frame) {
    this.decodePacket(frame, frame.data.payload);
    this.postContentMessage("frameSent",
      convertFromUnicode(JSON.stringify(frame)));
  },

  decodePacket: function(data, payload) {
    data.socketIo = this.decodeSocketIoPacket(payload);
    data.sockJs = this.decodeSockJsPacket(payload);
    data.wamp = this.decodeWampPacket(payload);
    data.json = this.decodeJsonPacket(payload);
  },

  // Socket.IO Parser

  decodeSocketIoPacket: function(data) {
    let result;
    try {
      var decoder = new socketIoParser.Decoder();
      decoder.on("decoded", function(decodedPacket) {
        if (decodedPacket.data != "parser error") {
          result = decodedPacket;
        }
      });
      decoder.add(data);
    } catch (err) {
      return;
    }

    // Valid Socket.IO packet needs to have a type.
    if (result && result.type) {
      return result;
    }
  },

  /**
   * Parse Sock.JS
   */
  decodeSockJsPacket: function(data) {
    return sockJsParser.parse(data);
  },

  /**
   * Parse JSON
   */
  decodeJsonPacket: function(data) {
    try {
      return JSON.parse(data);
    } catch (err) {
      return;
    }
  },

  /**
   * Parse WAMP
   */
  decodeWampPacket: function(data) {
    try {
      var wampObj = wampParser.parse(data);
      var result = {};
      for (let prop in wampObj) {
        if (!prop.startsWith("_")) {
          result[prop] = wampObj[prop];
        }
      }
      return result;
    } catch (err) {
    }
  },

  // NetMonitor Overlay

  /**
   * Executed by NetMonitor overlay when the user clicks on WS icon
   * in the Network panel and the WS panel is selected.
   */
  selectUpgradeEvent: function(actorId) {
    // xxxHonza: select the event in the list.
    // (currently not displayed)
  }
});

function convertFromUnicode(text) {
  if (!text) {
    return "";
  }

  try {
    var conv = Cc["@mozilla.org/intl/scriptableunicodeconverter"]
      .createInstance(Ci.nsIScriptableUnicodeConverter);
    conv.charset = "UTF-8";
    return conv.ConvertFromUnicode(text);
  } catch (err) {
    console.error(err);
  }

  return "";
};

// Registration
const myTool = new Tool({
  name: "MyTool",
  panels: {
    WsmPanel: WsmPanel
  }
});
