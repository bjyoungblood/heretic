# Heretic

An opinionated background job runner. Job payloads, logs, and metadata are backed
by Postgres. Job queueing and execution are backed by RabbitMQ.

Also, ES6/7.

### Why?

Lots of job queues are backed by Redis, but in order to leverage Redis's queueing
in a consistent way, you have to write a lot of Lua scripts, and you can still
easily run into issues with jobs getting stuck in [weird, inconsistent states](https://github.com/Automattic/kue/search?q=stuck&type=Issues).

Redis is also not a great option if you want to be able to search and filter
jobs (by type, by payload, etc). It's up to you (or your queueing library) to
implement your own indexing.

### Should I use it?

Probably not. It wouldn't be my first Terrible Idea™.

## Usage

Not implemented yet:

 - Automatic failure retries
 - Tests

### Database Schema

Feel free to add any other triggers/indexes you'd like.

```sql
CREATE TABLE heretic_jobs (
  id SERIAL NOT NULL PRIMARY KEY,
  queue_name text NOT NULL,
  status text DEFAULT 'pending',
  payload jsonb,
  attempt_logs text[] DEFAULT '{}',
  max_attempts int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_attempted_at timestamptz
);

CREATE INDEX ON heretic_jobs (queue_name);
CREATE INDEX ON heretic_jobs (status);

CREATE FUNCTION heretic_updated_at_timestamp() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE 'plpgsql';

CREATE TRIGGER update_heretic_jobs_updated_at
  BEFORE UPDATE ON heretic_jobs
  FOR EACH ROW EXECUTE PROCEDURE heretic_updated_at_timestamp();
```

### Example

```js
import Promise from 'bluebird';
import Heretic from 'heretic';
import knex from 'knex';

const heretic = new Heretic('amqp://127.0.0.1', knex({
  client : 'pg',
  connection : 'postgres://127.0.0.1',
}));

heretic.process('my.job', function(job, message, done) {
  Promise.resolve()
    .then(() => {
      // do some processing or something. whatever you want!
    })
    .nodeify(done);
});

heretic.process('other.job', function(job, message, done) {
  setTimeout(() => {
    done(new Error('job failed'));
  }, 1000);
});

// the 'jobError' event happens when a job message is published in RabbitMQ that
// can never be handled correctly (malformed JSON, job id doesn't exist in the
// database, etc.). The message will be dead-lettered for later inspection (by you)
heretic.on('jobError', (err) => {
  console.error('Error with job!', err.stack);
});

// the 'jobFailed' event happens when a job fails, but in a recoverable way. it
// will be automatically retried up to the maximum number of retries.
heretic.on('jobFailed', (err) => {
  console.error('Job execution failed!', err.stack);
});

// enqueue a job
heretic.enqueue('email.send', {
  to : 'bob@example.com',
  body : 'Hi',
});
```
