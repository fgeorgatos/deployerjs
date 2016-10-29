
"use strict";

var async = require('async');
var readline = require('readline');
var Spinner = require('multispinner');
var fs = require('fs');
var util  = require('util')

const SpinnerReporter = require('./reporters/StdReporter')
const DeployUtils = require('./utils/DeployUtils')
const GitStrategy = require('./strategies/GitStrategy')
const ConnUtils   = require('./utils/ConnUtils')
const HookUtils   = require('./utils/HookUtils')

module.exports = class Deployer {

  constructor(conf) {
    this.envs = conf;
    this.groups = {};

    // compute group of each env if defined
    for (let env in conf) {
      if (!env || !env.group) continue;

      if (groups[env.group])
        groups[env.group].push(env);
      else {
        groups[env.group] = [];
        groups[env.group].push(env);
      }
    }
  }

  /**
   * Function called to any remote action, for example ask for credentials like ssh password or private key passphrase
   * 
   * @param {String} target   A declared environement OR a group of declared environements
   * @param {Function} cb(err, servers)   Callback called after preparation completed
  */
  select(target, cb) {
    var servers = DeployUtils.resolveServers(this.envs, this.groups, target);
    // an error is returned (malformed config)
    if (servers instanceof Error) return cb(servers);

    async.each(Object.keys(servers), function (server_name, next) {
      var server = servers[server_name];
      server.name = server_name;

      // if password or passphrase is a boolean (and true), the user must enter credentials for each server
      if ((typeof (server.password) === 'boolean' && server.password) || (typeof (server.passphrase) === 'boolean' && server.passphrase)) {
        var type = server.password ? 'password' : 'passphrase';

        DeployUtils.askUser(util.format('You need to provide a %s for server %s : ', type, server_name), (value) => {
          server[type] = value;
          return next(null);
        })
      }
      else
        return next(null);
    }, function (err) {
      return cb(err, servers);
    })
  }

  /**
   * Function called to make remote deployement on each remove servers
   * 
   * @param {Object} servers  Map with host for key and configuration in value
   */
  deploy(servers, cb) {
    // instanciate the reporter as soon as we got all servers
    this.reporter = new SpinnerReporter(Object.keys(servers));

    async.each(servers, (server, next) => {
      // create ssh connection to the hostname
      ConnUtils.create(server.name, server, (err, conn) => {
        if (err) return this.reporter.error(server.name, err, next);

        this.reporter.update(server.name, 'Verification of remote system');
        server.reporter = this.reporter;
        server.conn = conn;
        server.strategy = new GitStrategy(server);

        // ensure that the remote system is already setup
        DeployUtils.ensureSetup(server, (err) => {
          if (err) return this.reporter.error(server.name, err, next);

          this.reporter.update(server.name, 'Remote system is ready !')
          server.strategy.update((err) => {
            if (err) return this.reporter.error(server.name, err, next);

            HookUtils.call('post-deploy', server, (err) => {
              return err ? this.reporter.error(server.name, err) :
                  this.reporter.success(server.name, 'Remote system updated', next);
            })
          })
        })
      })
    }, function (err, results) {
      // clean all connections
      for(let server in servers) {
        if (servers[server].conn)
          servers[server].conn.end() 
      }
      return cb(err, results);
    })
  }
}
