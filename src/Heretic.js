import Promise from 'bluebird';
import { EventEmitter } from 'events';
import amqp from 'amqplib';
import Joi from 'joi';

import Queue from './Queue';

const optionsSchema = Joi.object().keys({
  tableName : Joi.string().default('heretic_jobs'),

  jobsExchange : Joi.string().default('heretic.jobs'),
  outcomesExchange : Joi.string().default('heretic.outcomes'),
  deadJobsExchange : Joi.string().default('heretic.dead'),

  jobOutcomesQueue : Joi.string().default('heretic.jobs.outcomes'),
  deadJobsQueue : Joi.string().default('heretic.jobs.dead'),

  outcomeRoutingKeyPrefix : Joi.string().default('job-outcome'),

  socketOptions : Joi.object().optional().keys({
    clientProperties : Joi.object().optional().unknown().keys({
      Application : Joi.string().optional(),
    }),
  }),

  writeOutcomes : Joi.boolean().default('true'),
});

export default class Heretic extends EventEmitter {
  constructor(amqpUrl, knex, options = {}) {
    super();

    Joi.assert(amqpUrl, Joi.string().uri().label('amqpUrl'));
    Joi.validate(options, optionsSchema, (err, value) => {
      if (err) {
        throw err;
      }

      options = value;
    });

    if (! knex) {
      throw new Error('A valid knex instance must be provided');
    }

    this.amqpUrl = amqpUrl;
    this.knex = knex;
    this.options = options;
    this.queues = {};

    this.connection = null;
    this.controlChannel = null;
  }

  async init() {
    if (this.connection && this.controlChannel) {
      return Promise.resolve();
    }

    this.connection = await amqp.connect(this.amqpUrl, this.socketOptions);
    this.controlChannel = await this.connection.createConfirmChannel();

    this.controlChannel.on('error', (err) => {
      this.emit('error', err);
    });

    this.connection.on('error', (err) => {
      this.emit('error', err);
    });
  }

  async enqueue(queueName, payload, options = {}) {
    await this.init();

    return await this.knex.transaction(async (trx) => {
      let row = {
        queue_name : queueName,
        payload : payload,
      };

      if (options.maxAttempts) {
        row.max_attempts = options.maxAttempts;
      }

      let inserts = await trx(this.options.tableName)
        .insert(row)
        .returning('*');

      let job = inserts[0];

      return job;
    })
      .tap(async (job) => {
        await this.publishConfirm(
          this.options.jobsExchange,
          queueName,
          new Buffer(JSON.stringify({ id : job.id })),
        );
      });
  }

  async retry(id) {
    await this.init();

    return await this.knex.transaction(async (trx) => {
      let result = await this.knex(this.options.tableName)
        .update({ status : 'pending' })
        .where({ id })
        .returning('*');

      let job = result[0];

      if (! job) {
        throw new Error('Job not found');
      }

      await this.publishConfirm(
        this.options.jobsExchange,
        job.queue_name,
        new Buffer(JSON.stringify({ id : job.id })),
      );
    });
  }

  process(name, concurrency, handler) {
    Joi.assert(name, Joi.string().label('name'));
    Joi.assert(concurrency, Joi.number().min(1).label('concurrency'));
    Joi.assert(handler, Joi.func().label('handler'));

    if (this.queues[name]) {
      throw new Error(`Queue "${name}" already registered`);
    }

    this.queues[name] = new Queue(this, name, concurrency, handler);
    this.queues[name].on('error', (err) => {
      this.emit('jobError', err);
    });

    this.queues[name].on('jobSuccess', (job) => {
      this.emit('jobSuccess', job);
    });

    this.queues[name].on('jobFailed', (job, err) => {
      this.emit('jobFailed', job, err);
    });
  }

  async start() {
    await this.init();

    try {
      await this.assertEnvironment();
    } catch (err) {
      await this.controlChannel.close();
      await this.connection.close();
      throw err;
    }

    try {
      for (let name in this.queues) {
        if (! this.queues.hasOwnProperty(name)) {
          continue;
        }

        await this.queues[name].start();
      }
    } catch (err) {
      await this.connection.close();
      throw err;
    }
  }

  async assertEnvironment() {
    const ch = await this.connection.createChannel();

    // error events from this channel will result in promises being rejected
    ch.on('error', (err) => {});

    await ch.assertExchange(this.options.jobsExchange, 'topic', { durable : true });
    if (this.options.writeOutcomes) {
      await ch.assertExchange(this.options.outcomesExchange, 'topic', { durable : true });
    }
    await ch.assertExchange(this.options.deadJobsExchange, 'direct', {
      durable : true,
      internal : true,
    });

    if (this.options.writeOutcomes) {
      await ch.assertQueue(this.options.jobOutcomesQueue, {
        durable : true,
        arguments : {
          'x-dead-letter-exchange' : this.options.deadJobsExchange,
          'x-dead-letter-routing-key' : this.options.deadJobsQueue,
        },
      });
    }

    await ch.assertQueue(this.options.deadJobsQueue, {
      durable : true,
    });

    if (this.options.writeOutcomes) {
      await ch.bindQueue(
        this.options.jobOutcomesQueue,
        this.options.outcomesExchange,
        this.options.outcomeRoutingKeyPrefix + '.#',
      );
    }

    for (let name in this.queues) {
      if (! this.queues.hasOwnProperty(name)) {
        continue;
      }

      await ch.assertQueue(name, {
        durable : true,
        arguments : {
          'x-dead-letter-exchange' : this.options.deadJobsExchange,
          'x-dead-letter-routing-key' : this.options.deadJobsQueue,
        },
      });

      await ch.bindQueue(
        name,
        this.options.jobsExchange,
        name,
      );
    }

    await ch.close();
  }

  publishConfirm(exchange, routingKey, content, options = {}) {
    return new Promise((resolve, reject) => {
      this.controlChannel.publish(exchange, routingKey, content, options, (err) => {
        if (err) {
          return reject(err);
        }

        return resolve();
      });
    });
  }

}
