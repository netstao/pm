/* vim: set expandtab tabstop=2 shiftwidth=2 foldmethod=marker: */

"use strict";

var util = require('util');
var fork = require('child_process').fork;
var CPUS = require('os').cpus().length;

var Emitter = require('events').EventEmitter;

/* {{{ private function _extend() */
var _extend = function (a, b) {
  var a = a || {};
  for (var i in b) {
    a[i] = b[i];
  }
  return a;
};
/* }}} */

exports.create = function (argv, options, GNAME) {

  /* {{{ _options */
  var _options = _extend({
    'listen'   : [],
    'children' : CPUS,
    'max_fatal_restart'  : 5,
    'max_heartbeat_lost' : -1
  }, options);

  if (!_options.listen) {
    _options.listen = [];
  } else if (!Array.isArray(_options.listen)) {
    _options.listen = _options.listen.toString().split(',');
  }
  _options.listen.map(function (i) {
    return Number(i) || i;
  });
  /* }}} */

  /**
   * @ 监听句柄
   */
  var handles = {};
  var getHandle = function (idx) {
    if (!handles[idx]) {
      handles[idx] = common.getHandle(idx);
    }
    return handles[idx];
  };

  /**
   * @ 运行状态
   */
  var running = 0;

  /**
   * @ 进程状态表
   */
  var pstatus = {};

  /**
   * @ 即将消亡的进程列表
   */
  var dielist = [];

  /**
   * @ 异常退出
   */
  var pfatals = [];

  var command = argv.join(' ');
  var exepath = argv.shift();

  /* {{{ private function _fork() */
  var _fork = function () {
    var sub = fork(exepath, argv, {
      'cwd' : PROCESS.cwd(),
      'env' : _extend({}, PROCESS.env)
    });

    var pid = sub.pid;
    workers[pid] = sub;
    pstatus[pid] = {
      'uptime' : Date.now(),
    };

    /* {{{ private function _send() */
    var _send = function (type, data, handle) {
      try {
        sub.send({'type' : type, 'data' : data}, handle);
      } catch (e) {
      }
    };
    /* }}} */

    sub.on('exit', function (code, signal) {
      delete workers[pid];
      delete pstatus[pid];
      if (!running) {
        return;
      }

      /* {{{ 非正常退出 */

      if (code || 'SIGKILL' === signal) {
        var now = Date.now();
        if (pfatals.unshift(now) > _options.max_fatal_restart) {
          pfatals = pfatals.slice(0, _options.max_fatal_restart);
        }
        if (pfatals.length >= _options.max_fatal_restart && 
          pfatals[pfatals.length - 1] + 60000 >= now) {
          __GLOBAL_MASTER.emit('giveup', GNAME, pfatals.length);
          setTimeout(function () {
            _me.start();
          }, 60100);
          return;
        }
      }
      /* }}} */

      _me.start();
    });

    sub.on('message', function (msg) {

      /* {{{ gethandle */
      if ('gethandle' === msg.type) {
        _options.listen.forEach(function (i) {
          _send('listen', i, getHandle(i));
        });

        var die = 0;
        while (dielist.length > 0) {
          die = dielist.pop();
          if (workers[die]) {
            PROCESS.kill(die, 'SIGTERM');
            break;
          }
        }
        return;
      }
      /* }}} */

      if ('heartbeat' === msg.type) {
        pstatus = _extend(_extend(pstatus, msg.data), {
          '_time' : Date.now()
        });
        return;
      }

      if ('broadcast' === msg.type) {
        var m = msg.data;
        if (m && m.who) {
          __GLOBAL_MASTER.broadcast(m.who, m.msg, GNAME, pid);
        }
        return;
      }
    });
  };
  /* }}} */

  var _me = {};

  /* {{{ public function broadcast() */
  _me.broadcast = function (msg, from, pid) {
    Object.keys(workers).forEach(function (i) {
      try {
        workers[i].send({
          'type' : 'hello',
          'data' : msg,
          'from' : from,
          '_pid' : pid
        });
      } catch (e) {
      }
    });
  };
  /* }}} */

  /* {{{ public function start() */
  _me.start = function () {
    var n = 0;
    Object.keys(workers).forEach(function (i) {
      if (dielist.indexOf(i) < 0) {
        n++;
      }
    });

    while (n < _options.children) {
      _fork();
      n++;
    }
  };
  /* }}} */

  /* {{{ public function stop() */
  _me.stop = function (signal) {
    running = 0;
    Object.keys(handles).forEach(function (i) {
      handles[i].close();
      delete handles[i];
    });
    Object.keys(workers).forEach(function (i) {
      PROCESS.kill(i, signal || 'SIGTERM');
    });
    dielist.forEach(function (i) {
      PROCESS.kill(i, signal || 'SIGTERM');
    });
  };
  /* }}} */

  /* {{{ public function reload() */
  _me.reload = function () {
    dielist.forEach(function (i) {
      PROCESS.kill(i, 'SIGTERM');
    });
    dielist = Object.keys(workers);
    start();
  };
  /* }}} */

  return _me;
};
