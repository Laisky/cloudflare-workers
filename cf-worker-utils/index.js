'use strict';

import * as LZString from 'lz-string';

/**
 * Cache is a simple key-value cache based on Cloudflare KV.
 *
 * @class Cache
 * @example
 * const cache = new Cache('prefix', 3600);
 * cache.set('key', 'val');
 * cache.get('key');
 *
 */
export class Cache {
    constructor(prefix = 'default', ttl = 3600) {
        this.cachePrefix = prefix;
        this.cacheTTLSec = ttl;
    }

    setPrefix(prefix) {
        this.cachePrefix = prefix;
    }

    setTTL(ttl) {
        this.cacheTTLSec = ttl;
    }

    async set(prefix, key, val) {
        const cacheKey = this.cachePrefix + prefix + "/" + key;
        try {
            console.log(`set cache ${cacheKey}, val: ${JSON.stringify(val)}`);
            const compressed = LZString.compressToUTF16(JSON.stringify(val));
            return await KV.put(cacheKey, compressed, {
                expirationTtl: this.cacheTTLSec
            });
        } catch (e) {
            console.warn(`failed to set cache ${cacheKey}: ${e}`);
            return null;
        }
    }

    async get(prefix, key) {
        const cacheKey = this.cachePrefix + prefix + "/" + key;
        try {
            console.log('get cache ' + cacheKey);
            const compressed = await KV.get(cacheKey);
            if (compressed == null) {
                return null;
            }

            return JSON.parse(LZString.decompressFromUTF16(compressed));
        } catch (e) {
            console.warn(`failed to get cache ${cacheKey}: ${e}`);
            return null;
        }
    }
}
