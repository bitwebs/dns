const fs = require('fs')
const path = require('path')
const Database = require('better-sqlite3')
const envPaths = require('env-paths')
const debug = require('debug')('bit-dns')
const createCacheLRU = require('./cache-lru.js')

const Q_CREATE_TABLE = 'CREATE TABLE IF NOT EXISTS $table (name TEXT NOT NULL, protocol TEXT NOT NULL, updated INTEGER NOT NULL, key TEXT, expires INTEGER NOT NULL, PRIMARY KEY (name, protocol))'
const Q_WRITE = 'REPLACE INTO $table (name, protocol, updated, key, expires) VALUES ($name, $protocol, $updated, $key, $expires)'
const Q_CLEAR_NAME = 'DELETE FROM $table WHERE name = $name'
const Q_CLEAR = 'DELETE FROM $table'
const Q_READ = 'SELECT key, expires from $table WHERE name = $name AND protocol = $protocol'
const Q_FLUSH = 'DELETE FROM $table WHERE expires < $now'

function createDemandDB (opts) {
  let db = null
  return {
    demand () {
      /* c8 ignore start */
      // Not tested it this case may be happening when a db closes as result of an internal error
      if (db !== null && !db.open) {
        db.close()
        db = null
      }
      /* c8 ignore end */
      if (db === null) {
        db = openDb(opts)
      }
      return db
    },
    close () {
      if (db !== null && db.open) {
        db.close()
        db = null
      }
    }
  }
}

function openDb (opts) {
  const { file, table, autoClose, maxWalSize, walCheckInterval } = opts
  debug('opening database %s: %s', file, table)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file)
  db.pragma('journal_mode = WAL')

  // Making sure that the table exists
  const s = db.prepare(Q_CREATE_TABLE.replace('$table', table))
  debug(s.source)
  s.run()

  // Support helper for autoClose
  let count = 0
  let timeout
  const registerInterest = () => {
    if (timeout !== undefined) {
      clearTimeout(timeout)
      timeout = undefined
    }
    count += 1
    return function unregister () {
      count -= 1
      if (count === 0 && db.open && autoClose > 0) {
        timeout = setTimeout(db.close, autoClose)
      }
    }
  }

  // Overriding close to make sure everything is properly closed
  const _close = db.close
  const close = () => {
    debug('closing db')
    if (timeout !== undefined) {
      clearTimeout(timeout)
      timeout = undefined
    }
    process.off('exit', close)
    if (db.open) {
      _close.call(db)
    }
    clearInterval(walClearInterval)
    return db
  }
  // See https://github.com/JoshuaWise/better-sqlite3/blob/master/docs/performance.md
  const walClearInterval = setInterval(fs.stat.bind(null, `${file}-wal`, (err, stat) => {
    if (!err && stat.size > maxWalSize && db.open) {
      db.pragma('wal_checkpoint(RESTART)')
    }
  }), walCheckInterval)
  process.on('exit', close)

  db.registerInterest = registerInterest
  db.close = close
  db.prepared = {}
  return db
}

function createQueryAPI (opts) {
  const demandDb = createDemandDB(opts)
  const { table } = opts
  return {
    run (query, args) {
      execStatement(query, statement => {
        debug('%s -- %s', statement.source, args)
        statement.run(args)
      })
    },
    one (query, args) {
      return execStatement(query, statement => {
        debug('%s -- %s', statement.source, args)
        return statement.get(args)
      })
    },
    close: demandDb.close
  }

  function execStatement (query, handler) {
    return exec(db => {
      let statement = db.prepared[query]
      if (statement === undefined) {
        statement = db.prepare(query.replace(/\$table/g, table))
        db.prepared[query] = statement
      }
      return handler(statement)
    })
  }

  function exec (handler) {
    const db = demandDb.demand()
    const unregister = db.registerInterest()
    try {
      return handler(db)
    } finally {
      unregister()
    }
  }
}

function createCacheSqlite (opts) {
  opts = {
    ...createCacheSqlite.DEFAULTS,
    ...opts
  }
  const lru = createCacheLRU(opts)
  const query = createQueryAPI(opts)
  return {
    async clear () {
      await lru.clear()
      query.run(Q_CLEAR, {})
    },
    async clearName (name) {
      await lru.clearName(name)
      query.run(Q_CLEAR_NAME, { name })
    },
    async close () {
      query.close()
    },
    async flush (timestamp) {
      timestamp = typeof timestamp === 'number' ? timestamp : Date.now()
      await lru.flush(timestamp)
      query.run(Q_FLUSH, { now: timestamp })
    },
    async get (protocol, name) {
      let entry = await lru.get(protocol, name)
      if (entry !== undefined) {
        return entry
      }
      try {
        entry = query.one(Q_READ, { protocol, name })
      } catch (error) {
        debug('error while restoring %s:%s from sqlite cache: %s', protocol, name, error)
        return
      }
      debug('successfully restored %s:%s from sqlite cache', protocol, name)
      await lru.set(protocol, name, entry)
      return entry
    },
    async set (protocol, name, entry) {
      await lru.set(protocol, name, entry)
      const { key, expires } = entry
      try {
        query.run(Q_WRITE, { protocol, name, expires, key, updated: Date.now() })
      } catch (error) {
        debug('error while storing %s:%s in sqlite cache: %s', protocol, name, error)
      }
    }
  }
}
createCacheSqlite.DEFAULTS = Object.freeze({
  ...createCacheLRU.DEFAULTS,
  table: 'names',
  autoClose: 5000,
  maxWalSize: 10 * 1024 * 1024, // 10 MB
  walCheckInterval: 5000, // 5s
  file: path.join(envPaths('bit-dns', { suffix: '' }).cache, 'cache.db')
})

module.exports = Object.freeze(createCacheSqlite)
