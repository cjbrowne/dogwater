'use strict';

const semverSplit = (version) => {

    const versionParts = version.split('.');

    return {
        MAJOR: versionParts[0],
        MINOR: versionParts[1],
        PATCH: versionParts[2]
    };
};

const Path = require('path');
const Hoek = require('hoek');
const Joi = require('joi');
const Waterline = require('waterline');
const WaterlineVersion = semverSplit(require('waterline/package.json').version);
const Schema = require('./schema');
const Package = require('../package.json');

const internals = {};

exports.register = function (server, options, next) {

    Joi.assert(options, Schema.plugin, 'Bad plugin options passed to dogwater.');

    const rootState = internals.state(server.root);

    if (!rootState.setup) {

        rootState.collector = {
            adapters: {},
            connections: {},
            models: {},
            defaults: {},
            teardownOnStop: null // Not set, effectively defaults true
        };

        if (WaterlineVersion.MAJOR === 0 &&
           WaterlineVersion.MINOR >= 13) {
          // rename property 'connections' to 'datastores'
            rootState.collector.datastores = rootState.collector.connections;
            rootState.collector.connections = undefined;
        }

        // Here's the ORM!
        server.decorate('server', 'waterline', new Waterline());
        server.decorate('server', 'dogwater', internals.dogwater);
        server.decorate('server', 'collections', internals.collections((ctx) => ctx, 'realm'));
        server.decorate('request', 'collections', internals.collections((ctx) => ctx.server, 'route.realm'));
        server.ext('onPreStart', internals.initialize);
        server.ext('onPostStop', internals.stop);

        rootState.setup = true;
    };

    // Collect defaults

    const collector = rootState.collector;
    const defaults = options.defaults || {};

    Object.keys(defaults).forEach((key) => {

        Hoek.assert(!collector.defaults[key], `Default for "${key}" has already been set.`);
        collector.defaults[key] = defaults[key];
    });

    // Decide whether server stop should teardown

    if (typeof options.teardownOnStop !== 'undefined') {
        Hoek.assert(collector.teardownOnStop === null, 'Dogwater\'s teardownOnStop option can only be specified once.');
        collector.teardownOnStop = options.teardownOnStop;
    }

    const config = internals.registrationConfig(options);
    server.root.dogwater(config);

    next();
};

exports.register.attributes = {
    pkg: Package,
    multiple: true
};

// Massage registration config for use with rejoice
internals.registrationConfig = (options) => {

    const config = Hoek.shallow(options);
    delete config.defaults;
    delete config.teardownOnStop;

    // Resolve models

    if (typeof config.models === 'string') {
        if (Path.isAbsolute(config.models)) {
            config.models = require(config.models);
        }
        else {
            config.models = require(Path.resolve(process.cwd(), config.models));
        }
    }

    // Resolve adapters

    Object.keys(config.adapters || {}).forEach((name) => {

        if (typeof config.adapters[name] === 'string') {
            config.adapters[name] = require(config.adapters[name]);
        }
    });

    return config;
};

internals.initialize = function (server, next) {

    const waterline = server.waterline;
    const collector = internals.state(server.root).collector;

    // Hand the models to waterline
    Object.keys(collector.models).forEach((id) => {

        const model = collector.models[id];
        const modelExtended = Waterline.Collection.extend(model);
        waterline.loadCollection(modelExtended);
    });

    const config = {
        adapters: collector.adapters,
        connections: collector.connections,
        defaults: collector.defaults
    };

    // Finally init waterline and carry on
    waterline.initialize(config, next);
};

internals.stop = function (server, next) {

    const collector = internals.state(server.root).collector;

    // Do not teardown if specifically ask not to
    if (collector.teardownOnStop === false) {
        return next();
    }

    return server.waterline.teardown(next);
};

internals.dogwater = function (config) {

    config = Joi.attempt(config, Schema.dogwater);

    // Array of models, coerce to config
    if (Array.isArray(config)) {
        config = { models: config };
    }

    // Apply empty defaults
    config.adapters = config.adapters || {};
    config.connections = config.connections || {};
    config.models = config.models || [];

    // Collect adapters, connections, models, ensuring no dupes

    const collector = internals.state(this.root).collector;
    const adapterNames = Object.keys(config.adapters);
    const connectionNames = Object.keys(config.connections);
    const modelIds = config.models.map((model) => model.identity);

    adapterNames.forEach((name) => {

        Hoek.assert(!collector.adapters[name], `Adapter "${name}" has already been registered.`);
        collector.adapters[name] = config.adapters[name];
    });

    connectionNames.forEach((name) => {

        Hoek.assert(!collector.connections[name], `Connection "${name}" has already been registered.`);
        collector.connections[name] = config.connections[name];
    });

    modelIds.forEach((id, index) => {

        Hoek.assert(!collector.models[id], `Model definition with identity "${id}" has already been registered.`);
        collector.models[id] = config.models[index];
    });

    // If all went well, track which models belong to which realms
    const state = internals.state(this);
    state.models = (state.models || []).concat(modelIds);
};

internals.collections = (serverFrom, realmPath) => {

    return function (all) {

        const waterline = serverFrom(this).waterline;

        if (!waterline.collections) {
            return {};
        }

        if (all) {
            return waterline.collections;
        }

        const collections = {};
        const models = Hoek.reach(this, `${realmPath}.plugins.dogwater.models`) || [];

        for (let i = 0; i < models.length; ++i) {
            collections[models[i]] = waterline.collections[models[i]];
        }

        return collections;
    };
};

internals.state = (srv) => {

    const state = srv.realm.plugins.dogwater = srv.realm.plugins.dogwater || {};

    return state;
};
