# toy-repo

A deliberately small service, used to exercise `adv`. It contains at
least one statement that does not match the code, on purpose.

## Rate limiting

`src/rateLimit.ts` provides in-process rate limiting. Counters are keyed by
client key and **reset every 60 seconds**.

## HTTP

`src/server.ts` calls the limiter for every request.
