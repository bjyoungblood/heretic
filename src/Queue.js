import { EventEmitter } from 'events';
import domain from 'domain';
import Promise from 'bluebird';

export default class Queue extends EventEmitter {
  constructor(heretic, name, concurrency, handler) {
    super();

    this.heretic = heretic;
    this.knex = this.heretic.knex;
    this.tableName = this.heretic.options.tableName;
    this.name = name;
    this.concurrency = concurrency;
    this.handler = handler;

    this.channel = null;
    this.consumerTag = null;
  }

  async start() {
    await this.openChannel();

    let { consumerTag } = await this.channel.consume(this.name, this.receiveJob.bind(this), {
      noAck : false,
    });

    this.consumerTag = consumerTag;
  }

  async pause() {
    if (this.channel) {
      await this.channel.cancel(this.consumerTag);
    }
  }

  async openChannel() {
    if (this.channel) {
      return;
    }

    this.channel = await this.heretic.connection.createChannel();
    this.channel.prefetch(this.concurrency);
  }

  async closeChannel() {
    await this.ch.close();
  }

  async fetchJob(trx, id) {
    let job = await trx(this.tableName)
      .select('*')
      .first()
      .where('id', id)
      .forUpdate();

    if (! job) {
      throw new Error('Job not found');
    }

    return job;
  }

  receiveJob(message) {
    let body;
    try {
      body = JSON.parse(message.content.toString('utf8'));

      if (! body.id) {
        throw new Error('Decoded message did not contain a job id');
      }
    } catch (e) {
      // we won't ever be able to handle this message properly, so
      this.channel.nack(message, false, false);

      this.emit('error', new Error('Unable to decode message content'));
      return;
    }

    this.knex.transaction(async (trx) => {
      let job;

      try {
        job = await this.fetchJob(trx, body.id);
      } catch (err) {
        this.channel.nack(message, false, false);

        this.emit('error', err);
        return;
      }

      let d = domain.create();
      return new Promise((resolve, reject) => {
        d.on('error', reject);

        d.run(this.handler, job, message, (err) => {
          if (err) {
            return reject(err);
          }

          return resolve();
        });
      })
        .then(async (result) => {
          let savedJob = await this.jobSuccess(trx, job.id);
          this.emit('jobSuccess', savedJob);

          await this.publishConfirm(
            this.heretic.options.outcomesExchange,
            `${this.heretic.options.outcomeRoutingKeyPrefix}.success`,
            message.content,
          );

          this.channel.ack(message, false);
        })
        .catch(async (err) => {
          let savedJob = await this.jobFailed(trx, job.id, err.stack);
          this.emit('jobFailed', savedJob, err);

          await this.publishConfirm(
            this.heretic.options.outcomesExchange,
            `${this.heretic.options.outcomeRoutingKeyPrefix}.failed`,
            message.content,
          );

          this.channel.ack(message, false);
        });
    });
  }

  async jobFailed(trx, jobId, message) {
    let result = await trx(this.tableName)
      .where({ id : jobId})
      .update({
        status : 'failed',
        attempt_logs : this.knex.raw('attempt_logs || ARRAY[?]', message),
        last_attempted_at : new Date(),
      })
      .returning('*');

    return result[0];
  }

  async jobSuccess(trx, jobId) {
    let result = await trx(this.tableName)
      .where({ id : jobId })
      .update({
        status : 'success',
        attempt_logs : this.knex.raw('attempt_logs || ARRAY[?]', 'success'),
        last_attempted_at : new Date(),
      })
      .returning('*');

    return result[0];
  }

  publishConfirm(exchange, routingKey, content, options = {}) {
    return new Promise((resolve, reject) => {
      this.heretic.controlChannel.publish(exchange, routingKey, content, options, (err) => {
        if (err) {
          return reject(err);
        }

        return resolve();
      });
    });
  }

}
