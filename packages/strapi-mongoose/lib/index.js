'use strict';

/**
 * Module dependencies
 */

// Public node modules.
const _ = require('lodash');
const Mongoose = require('mongoose').Mongoose;
const mongooseUtils = require('mongoose/lib/utils');

// Local helpers.
const utils = require('./utils/');

// Strapi helpers for models.
const { models: utilsModels, logger }  = require('strapi-utils');

/**
 * Bookshelf hook
 */

module.exports = function (strapi) {
  const hook = {

    /**
     * Default options
     */

    defaults: {
      defaultConnection: 'default',
      host: 'localhost',
      port: 27017,
      database: 'strapi'
    },

    /**
     * Initialize the hook
     */

    initialize: cb => {
      let globalName;

      // Return callback if there is no model
      if (_.isEmpty(strapi.models) || !_.pickBy(strapi.config.connections, {connector: 'strapi-mongoose'})) {
        return cb();
      }

      _.forEach(_.pickBy(strapi.config.connections, {connector: 'strapi-mongoose'}), (connection, connectionName) => {
        const instance = new Mongoose();
        const {host, port, username, password, database} = _.defaults(connection.settings, strapi.config.hook.settings.mongoose);

        // Connect to mongo database
        if (_.isEmpty(username) || _.isEmpty(password)) {
          instance.connect(`mongodb://${host}:${port}/${database}`, {
            useMongoClient: true
          });
        } else {
          instance.connect(`mongodb://${username}:${password}@${host}:${port}/${database}`, {
            useMongoClient: true
          });
        }

        // Handle error
        instance.connection.on('error', error => {
          if (error.message.indexOf(`:${port}`)) {
            return cb('Make sure your MongoDB database is running...');
          }

          cb(error);
        });

        // Handle success
        instance.connection.on('open', () => {
          // Select models concerned by this connection
          const models = _.pickBy(strapi.models, { connection: connectionName });

          // Return callback if there is no model
          if (_.isEmpty(models)) {
            return cb();
          }

          const loadedAttributes = _.after(_.size(models), () => {
            _.forEach(models, (definition, model) => {
              try {
                let collection = strapi.config.hook.settings.mongoose.collections[mongooseUtils.toCollectionName(definition.globalName)];

                // Set the default values to model settings.
                _.defaults(definition, {
                  primaryKey: '_id'
                });

                // Initialize lifecycle callbacks.
                const preLifecycle = {
                  validate: 'beforeCreate',
                  remove: 'beforeDestroy',
                  update: 'beforeUpdate',
                  find: 'beforeFetchAll',
                  findOne: 'beforeFetch',
                  save: 'beforeSave'
                };

                _.forEach(preLifecycle, (fn, key) => {
                  if (_.isFunction(strapi.models[model.toLowerCase()][fn])) {
                    collection.schema.pre(key, strapi.models[model.toLowerCase()][fn]);
                  }
                });

                const postLifecycle = {
                  validate: 'afterCreate',
                  remove: 'afterDestroy',
                  update: 'afterUpdate',
                  find: 'afterFetchAll',
                  findOne: 'afterFetch',
                  save: 'afterSave'
                };

                _.forEach(postLifecycle, (fn, key) => {
                  if (_.isFunction(strapi.models[model.toLowerCase()][fn])) {
                    collection.schema.post(key, strapi.models[model.toLowerCase()][fn]);
                  }
                });

                // Add virtual key to provide populate and reverse populate
                _.forEach(_.pickBy(definition.loadedModel, model => {
                  return model.type === 'virtual';
                }), (value, key) => {
                  collection.schema.virtual(key.replace('_v', ''), {
                    ref: value.ref,
                    localField: '_id',
                    foreignField: value.via,
                    justOne: value.justOne || false
                  });
                });

                collection.schema.set('toObject', {
                  virtuals: true
                });

                collection.schema.set('toJSON', {
                  virtuals: true
                });

                global[definition.globalName] = instance.model(definition.globalName, collection.schema);

                // Expose ORM functions through the `strapi.models` object.
                strapi.models[model] = _.assign(instance.model(definition.globalName), strapi.models[model]);

                // Push model to strapi global variables.
                collection = global[definition.globalName];

                // Push attributes to be aware of model schema.
                strapi.models[model]._attributes = definition.attributes;
              } catch (err) {
                strapi.log.error('Impossible to register the `' + model + '` model.');
                strapi.log.error(err);
                strapi.stop();
              }
            });

            cb();
          });

          // Parse every registered model.
          _.forEach(models, (definition, model) => {
            definition.globalName = _.upperFirst(_.camelCase(definition.globalId));

            // Make sure the model has a connection.
            // If not, use the default connection.
            if (_.isEmpty(definition.connection)) {
              definition.connection = strapi.config.defaultConnection;
            }

            // Make sure this connection exists.
            if (!_.has(strapi.config.connections, definition.connection)) {
              strapi.log.error('The connection `' + definition.connection + '` specified in the `' + model + '` model does not exist.');
              strapi.stop();
            }

            // Add some informations about ORM & client connection
            definition.orm = 'mongoose';
            definition.client = _.get(strapi.config.connections[definition.connection], 'client');

            // Register the final model for Bookshelf.
            definition.loadedModel = _.cloneDeep(definition.attributes);

            // Initialize the global variable with the
            // capitalized model name.
            global[definition.globalName] = {};

            if (_.isEmpty(definition.attributes)) {
              // Generate empty schema
              _.set(strapi.config.hook.settings.mongoose, 'collections.' + mongooseUtils.toCollectionName(definition.globalName) + '.schema', new instance.Schema({}));

              return loadedAttributes();
            }

            // Call this callback function after we are done parsing
            // all attributes for relationships-- see below.
            const done = _.after(_.size(definition.attributes), () => {
              // Generate schema without virtual populate
              _.set(strapi.config.hook.settings.mongoose, 'collections.' + mongooseUtils.toCollectionName(definition.globalName) + '.schema', new instance.Schema(_.omitBy(definition.loadedModel, model => {
                return model.type === 'virtual';
              })));

              loadedAttributes();
            });

            // Add every relationships to the loaded model for Bookshelf.
            // Basic attributes don't need this-- only relations.
            _.forEach(definition.attributes, (details, name) => {
              const verbose = _.get(utilsModels.getNature(details, name, undefined, model.toLowerCase()), 'verbose') || '';

              // Build associations key
              utilsModels.defineAssociations(model, definition, details, name);

              if (_.isEmpty(verbose)) {
                definition.loadedModel[name].type = utils(instance).convertType(details.type);
              }

              let FK;

              switch (verbose) {
                case 'hasOne':
                  definition.loadedModel[name] = {
                    type: instance.Schema.Types.ObjectId,
                    ref: _.capitalize(details.model)
                  };
                  break;
                case 'hasMany':
                  FK = _.find(definition.associations, {alias: name});

                  if (FK) {
                    definition.loadedModel[name] = {
                      type: 'virtual',
                      ref: _.capitalize(details.collection),
                      via: FK.via,
                      justOne: false
                    };

                    // Set this info to be able to see if this field is a real database's field.
                    details.isVirtual = true;
                  } else {
                    definition.loadedModel[name] = [{
                      type: instance.Schema.Types.ObjectId,
                      ref: _.capitalize(details.collection)
                    }];
                  }
                  break;
                case 'belongsTo':
                  FK = _.find(definition.associations, {alias: name});

                  if (FK && FK.nature !== 'oneToOne' && FK.nature !== 'manyToOne') {
                    definition.loadedModel[name] = {
                      type: 'virtual',
                      ref: _.capitalize(details.model),
                      via: FK.via,
                      justOne: true
                    };

                    // Set this info to be able to see if this field is a real database's field.
                    details.isVirtual = true;
                  } else {
                    definition.loadedModel[name] = {
                      type: instance.Schema.Types.ObjectId,
                      ref: _.capitalize(details.model)
                    };
                  }

                  break;
                case 'belongsToMany':
                  FK = _.find(definition.associations, {alias: name});

                  // One-side of the relationship has to be a virtual field to be bidirectional.
                  if ((FK && _.isUndefined(FK.via)) || details.dominant !== true) {
                    definition.loadedModel[name] = {
                      type: 'virtual',
                      ref: _.capitalize(FK.collection),
                      via: FK.via
                    };

                    // Set this info to be able to see if this field is a real database's field.
                    details.isVirtual = true;
                  } else {
                    definition.loadedModel[name] = [{
                      type: instance.Schema.Types.ObjectId,
                      ref: _.capitalize(details.collection)
                    }];
                  }
                  break;
                default:
                  break;
              }

              done();
            });
          });
        });
      });
    },

    getQueryParams: (value, type, key) => {
      const result = {};

      switch (type) {
        case '=':
          result.key = `where.${key}`;
          result.value = value;
          break;
        case '_ne':
          result.key = `where.${key}.$ne`;
          result.value = value;
          break;
        case '_lt':
          result.key = `where.${key}.$lt`;
          result.value = value;
          break;
        case '_gt':
          result.key = `where.${key}.$gt`;
          result.value = value;
          break;
        case '_lte':
          result.key = `where.${key}.$lte`;
          result.value = value;
          break;
        case '_gte':
          result.key = `where.${key}.$gte`;
          result.value = value;
          break;
        case '_sort':
          result.key = `sort`;
          result.value = (value === 'desc') ? '-' : '';
          result.value += key;
          break;
        case '_start':
          result.key = `start`;
          result.value = parseFloat(value);
          break;
        case '_limit':
          result.key = `limit`;
          result.value = parseFloat(value);
          break;
        default:
          result = undefined;
      }

      return result;
    },

    manageRelations: async function (model, params) {
      const models = strapi.models;
      const Model = strapi.models[model];

      const virtualFields = [];
      const response = await Model
        .findOne({
          [Model.primaryKey]: params._id || params.id
        })
        .populate(_.keys(_.groupBy(_.reject(Model.associations, {autoPopulate: false}), 'alias')).join(' '));

      // Only update fields which are on this document.
      const values = params.parseRelationships === false ? params.values : Object.keys(JSON.parse(JSON.stringify(params.values))).reduce((acc, current) => {
        const association = Model.associations.filter(x => x.alias === current)[0];
        const details = Model._attributes[current];

        if (_.get(Model._attributes, `${current}.isVirtual`) !== true && _.isUndefined(association)) {
          acc[current] = params.values[current];
        } else {
          switch (association.nature) {
            case 'oneToOne':
              if (response[current] !== params.values[current]) {
                const value = _.isNull(params.values[current]) ? response[current] : params.values;

                const recordId = _.isNull(params.values[current]) ? value[Model.primaryKey] || value.id || value._id : value[current];

                if (response[current] && _.isObject(response[current]) && response[current][Model.primaryKey] !== value[current]) {
                  virtualFields.push(
                    this.manageRelations(details.model || details.collection, {
                      _id: response[current][Model.primaryKey],
                      values: {
                        [details.via]: null
                      },
                      parseRelationships: false
                    })
                  );
                }

                // Remove previous relationship asynchronously if it exists.
                virtualFields.push(
                  models[details.model || details.collection]
                    .findOne({ id : recordId })
                    .populate(_.keys(_.groupBy(_.reject(models[details.model || details.collection].associations, {autoPopulate: false}), 'alias')).join(' '))
                    .then(record => {
                      if (record && _.isObject(record[details.via])) {
                        return this.manageRelations(details.model || details.collection, {
                          id: record[details.via][Model.primaryKey] || record[details.via].id,
                          values: {
                            [current]: null
                          },
                          parseRelationships: false
                        });
                      }

                      return Promise.resolve();
                    })
                );

                // Update the record on the other side.
                // When params.values[current] is null this means that we are removing the relation.
                virtualFields.push(this.manageRelations(details.model || details.collection, {
                  id: recordId,
                  values: {
                    [details.via]: _.isNull(params.values[current]) ? null : value[Model.primaryKey] || params.id || params._id || value.id || value._id
                  },
                  parseRelationships: false
                }));

                acc[current] = _.isNull(params.values[current]) ? null : value[current];
              }

              break;
            case 'oneToMany':
            case 'manyToOne':
            case 'manyToMany':
              if (details.dominant === true) {
                acc[current] = params.values[current];
              } else if (response[current] && _.isArray(response[current]) && current !== 'id') {
                // Records to add in the relation.
                const toAdd = _.differenceWith(params.values[current], response[current], (a, b) =>
                  ((typeof a === 'string') ? a : a[Model.primaryKey].toString()) === b[Model.primaryKey].toString()
                );
                // Records to remove in the relation.
                const toRemove = _.differenceWith(response[current], params.values[current], (a, b) =>
                  a[Model.primaryKey].toString() === ((typeof b === 'string') ? b : b[Model.primaryKey].toString())
                )
                  .filter(x => toAdd.find(y => x.id === y.id) === undefined);

                // Push the work into the flow process.
                toAdd.forEach(value => {
                  value = (typeof value === 'string') ? { _id: value } : value;

                  if (association.nature === 'manyToMany' && !_.isArray(params.values[Model.primaryKey])) {
                    value[details.via] = (value[details.via] || []).concat([response[Model.primaryKey]]);
                  } else {
                    value[details.via] = params[Model.primaryKey];
                  }

                  virtualFields.push(this.manageRelations(details.model || details.collection, {
                    id: value[Model.primaryKey] || value.id || value._id,
                    values: value,
                    foreignKey: current
                  }));
                });

                toRemove.forEach(value => {
                  value = (typeof value === 'string') ? { _id: value } : value;

                  if (association.nature === 'manyToMany' && !_.isArray(params.values[Model.primaryKey])) {
                    value[details.via] = value[details.via].filter(x => x.toString() !== response[Model.primaryKey].toString());
                  } else {
                    value[details.via] = null;
                  }

                  virtualFields.push(this.manageRelations(details.model || details.collection, {
                    id: value[Model.primaryKey] || value.id || value._id,
                    values: value,
                    foreignKey: current
                  }));
                });
              } else if (_.get(Model._attributes, `${current}.isVirtual`) !== true) {
                acc[current] = params.values[current];
              }

              break;
            default:
          }
        }

        return acc;
      }, {});

      virtualFields.push(Model
        .update({
          [Model.primaryKey]: params[Model.primaryKey] || params.id
        }, values, {
          strict: false
        }));

      // Update virtuals fields.
      const process = await Promise.all(virtualFields);

      return process[process.length - 1];
    }
  };

  return hook;
};
