const DEFAULT_CONFIG = {
  upstreams: {
    cernet4: ["https://ispip.clang.cn/cernet.txt"],
    cernet6: ["https://ispip.clang.cn/cernet_ipv6.txt"]
  },

  exclude4: [
    "0.0.0.0/0",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "224.0.0.0/4"
  ],

  exclude6: [
    "::/128",
    "::1/128",
    "fc00::/7",
    "fe80::/10",
    "ff00::/8"
  ],

  minCount: {
    cernet4: 10,
    cernet6: 5
  },

  cacheKeys: {
    config: "cernet:config",
    cernet4: "cernet4:last-good",
    cernet6: "cernet6:last-good"
  }
};

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = normalizePath(url.pathname);

      if (path === "/health") {
        return jsonResponse({ ok: true });
      }

      const auth = await authorize(request, env);
      if (!auth.ok) {
        return jsonResponse({ ok: false, error: auth.error }, auth.status);
      }

      const forceRefresh = url.searchParams.has("refresh");

      if (path === "/refresh") {
        const result = await refreshAll(env);
        return jsonResponse(result);
      }

      const config = await loadConfig(env);

      if (path === "/" || path === "/cernet4.txt") {
        const data = await getRuleData(env, config, "cernet4", forceRefresh);
        return textResponse(data.cidrs.join("\n") + "\n", "text/plain; charset=utf-8", data);
      }

      if (path === "/cernet6.txt") {
        const data = await getRuleData(env, config, "cernet6", forceRefresh);
        return textResponse(data.cidrs.join("\n") + "\n", "text/plain; charset=utf-8", data);
      }

      if (path === "/cernet.txt") {
        const v4 = await getRuleData(env, config, "cernet4", forceRefresh);
        const v6 = await getRuleData(env, config, "cernet6", forceRefresh);
        const body = [...v4.cidrs, ...v6.cidrs].join("\n") + "\n";
        return textResponse(body, "text/plain; charset=utf-8", mergeMeta(v4, v6));
      }

      if (path === "/cernet4.surge") {
        const data = await getRuleData(env, config, "cernet4", forceRefresh);
        return textResponse(toSurge(data.cidrs, "IP-CIDR"), "text/plain; charset=utf-8", data);
      }

      if (path === "/cernet6.surge") {
        const data = await getRuleData(env, config, "cernet6", forceRefresh);
        return textResponse(toSurge(data.cidrs, "IP-CIDR6"), "text/plain; charset=utf-8", data);
      }

      if (path === "/cernet.surge") {
        const v4 = await getRuleData(env, config, "cernet4", forceRefresh);
        const v6 = await getRuleData(env, config, "cernet6", forceRefresh);
        const body = toSurge(v4.cidrs, "IP-CIDR") + toSurge(v6.cidrs, "IP-CIDR6");
        return textResponse(body, "text/plain; charset=utf-8", mergeMeta(v4, v6));
      }

      if (path === "/cernet4.mihomo.yaml" || path === "/cernet4.clash.yaml") {
        const data = await getRuleData(env, config, "cernet4", forceRefresh);
        return textResponse(toMihomo(data.cidrs), "text/yaml; charset=utf-8", data);
      }

      if (path === "/cernet6.mihomo.yaml" || path === "/cernet6.clash.yaml") {
        const data = await getRuleData(env, config, "cernet6", forceRefresh);
        return textResponse(toMihomo(data.cidrs), "text/yaml; charset=utf-8", data);
      }

      if (path === "/cernet.mihomo.yaml" || path === "/cernet.clash.yaml") {
        const v4 = await getRuleData(env, config, "cernet4", forceRefresh);
        const v6 = await getRuleData(env, config, "cernet6", forceRefresh);
        return textResponse(toMihomo([...v4.cidrs, ...v6.cidrs]), "text/yaml; charset=utf-8", mergeMeta(v4, v6));
      }

      if (path === "/cernet4.json") {
        const data = await getRuleData(env, config, "cernet4", forceRefresh);
        return jsonResponse(data);
      }

      if (path === "/cernet6.json") {
        const data = await getRuleData(env, config, "cernet6", forceRefresh);
        return jsonResponse(data);
      }

      if (path === "/config") {
        return jsonResponse(sanitizeConfig(config));
      }

      return jsonResponse({ ok: false, error: "not found" }, 404);
    } catch (err) {
      return jsonResponse({
        ok: false,
        error: err && err.message ? err.message : String(err)
      }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshAll(env));
  }
};

function normalizePath(pathname) {
  return (pathname || "/").replace(/\/+$/, "") || "/";
}

async function authorize(request, env) {
  const configured = getAuthTokens(env);
  if (configured.length === 0) {
    return { ok: false, status: 500, error: "AUTH_TOKEN or AUTH_TOKENS is not configured" };
  }

  const url = new URL(request.url);
  const authHeader = request.headers.get("authorization") || "";
  const xToken = request.headers.get("x-auth-token") || "";
  const queryToken = url.searchParams.get("token") || "";

  let presented = "";

  if (authHeader.toLowerCase().startsWith("bearer ")) {
    presented = authHeader.slice(7).trim();
  } else if (xToken) {
    presented = xToken.trim();
  } else if (queryToken) {
    presented = queryToken.trim();
  }

  if (!presented) {
    return { ok: false, status: 401, error: "missing token" };
  }

  for (const token of configured) {
    if (await safeEqual(presented, token)) {
      return { ok: true };
    }
  }

  return { ok: false, status: 403, error: "invalid token" };
}

function getAuthTokens(env) {
  const raw = env.AUTH_TOKENS || env.AUTH_TOKEN || "";
  return raw
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

async function safeEqual(a, b) {
  const ah = await sha256Hex(a);
  const bh = await sha256Hex(b);
  return ah === bh;
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function loadConfig(env) {
  const base = structuredClone(DEFAULT_CONFIG);

  let external = null;

  if (env.CONFIG_URL) {
    external = await fetchJsonConfig(env.CONFIG_URL);
  } else if (env.RULES_KV) {
    const kvConfigKey = base.cacheKeys.config;
    external = await env.RULES_KV.get(kvConfigKey, { type: "json" });
  } else if (env.CONFIG_JSON) {
    external = JSON.parse(env.CONFIG_JSON);
  }

  return mergeConfig(base, external || {});
}

async function fetchJsonConfig(url) {
  const res = await fetch(url, {
    headers: { "user-agent": "cernet-rule-worker/2.0" },
    cf: { cacheTtl: 300, cacheEverything: true }
  });

  if (!res.ok) {
    throw new Error(`CONFIG_URL failed: HTTP ${res.status}`);
  }

  return await res.json();
}

function mergeConfig(base, override) {
  const result = structuredClone(base);

  if (override.upstreams) {
    result.upstreams = {
      ...result.upstreams,
      ...override.upstreams
    };
  }

  if (Array.isArray(override.exclude4)) result.exclude4 = override.exclude4;
  if (Array.isArray(override.exclude6)) result.exclude6 = override.exclude6;

  if (override.minCount) {
    result.minCount = {
      ...result.minCount,
      ...override.minCount
    };
  }

  if (override.cacheKeys) {
    result.cacheKeys = {
      ...result.cacheKeys,
      ...override.cacheKeys
    };
  }

  return result;
}

async function refreshAll(env) {
  const config = await loadConfig(env);
  const out = {};

  out.cernet4 = await refreshOne(env, config, "cernet4").catch(err => ({
    ok: false,
    error: String(err.message || err)
  }));

  out.cernet6 = await refreshOne(env, config, "cernet6").catch(err => ({
    ok: false,
    error: String(err.message || err)
  }));

  return {
    ok: Boolean(out.cernet4.ok || out.cernet6.ok),
    results: out
  };
}

async function getRuleData(env, config, listName, forceRefresh) {
  if (forceRefresh) {
    return await refreshOne(env, config, listName);
  }

  const key = config.cacheKeys[listName];

  if (env.RULES_KV && key) {
    const cached = await env.RULES_KV.get(key, { type: "json" });
    if (cached && Array.isArray(cached.cidrs) && cached.cidrs.length > 0) {
      return { ...cached, fromCache: true };
    }
  }

  return await refreshOne(env, config, listName);
}

async function refreshOne(env, config, listName) {
  const urls = config.upstreams[listName] || [];
  const family = listName.endsWith("6") ? 6 : 4;
  const exclude = family === 6 ? config.exclude6 : config.exclude4;
  const minCount = config.minCount[listName] ?? 1;
  const key = config.cacheKeys[listName];

  if (!Array.isArray(urls) || urls.length === 0) {
    const cached = await getCached(env, key);
    if (cached) return { ...cached, fromCache: true, stale: true, warning: "no upstream configured" };
    throw new Error(`${listName}: no upstream configured and no cache`);
  }

  const errors = [];
  let rawAll = "";

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": "cernet-rule-worker/2.0" },
        cf: { cacheTtl: 3600, cacheEverything: true }
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      rawAll += "\n" + await res.text();
    } catch (err) {
      errors.push(`${url}: ${err.message || String(err)}`);
    }
  }

  const cidrs = normalizeCidrs(rawAll, family, exclude);

  if (cidrs.length < minCount) {
    const cached = await getCached(env, key);
    if (cached) {
      return {
        ...cached,
        fromCache: true,
        stale: true,
        warning: `${listName}: refresh failed or too few CIDRs`,
        errors
      };
    }

    throw new Error(`${listName}: too few CIDRs after parse: ${cidrs.length}; errors=${errors.join("; ")}`);
  }

  const data = {
    ok: true,
    name: listName,
    family,
    count: cidrs.length,
    cidrs,
    updatedAt: new Date().toISOString(),
    fromCache: false,
    stale: false,
    sourceErrors: errors
  };

  if (env.RULES_KV && key) {
    await env.RULES_KV.put(key, JSON.stringify(data));
  }

  return data;
}

async function getCached(env, key) {
  if (!env.RULES_KV || !key) return null;
  const cached = await env.RULES_KV.get(key, { type: "json" });
  if (cached && Array.isArray(cached.cidrs) && cached.cidrs.length > 0) {
    return cached;
  }
  return null;
}

function normalizeCidrs(raw, family, excludeCidrs) {
  const excludes = excludeCidrs
    .map(cidr => parseCidr(cidr, family))
    .filter(Boolean);

  const tokens = extractTokens(raw);
  const result = [];

  for (const token of tokens) {
    const cidr = parseCidr(token, family);
    if (!cidr) continue;

    const conflict = excludes.some(ex => rangesOverlap(cidr.range, ex.range));
    if (conflict) continue;

    result.push(cidr.normalized);
  }

  return [...new Set(result)].sort((a, b) => compareCidr(a, b, family));
}

function extractTokens(raw) {
  const tokens = [];

  for (const originalLine of raw.split(/\n/)) {
    let line = originalLine.trim();
    if (!line) continue;

    // 支持 #、//、; 注释；会处理行尾注释
    line = stripComment(line).trim();
    if (!line) continue;

    // 兼容空格分隔、逗号格式、Surge/Mihomo 规则格式
    for (const part of line.split(/\s+/)) {
      const cleaned = stripComment(part).trim();
      if (!cleaned) continue;

      const pieces = cleaned.split(",").map(s => s.trim()).filter(Boolean);

      if (/^IP-CIDR6?$/i.test(pieces[0]) && pieces[1]) {
        tokens.push(pieces[1]);
      } else {
        tokens.push(pieces[0]);
      }
    }
  }

  return tokens;
}

function stripComment(line) {
  const markers = ["#", "//", ";"];
  let cut = line.length;

  for (const marker of markers) {
    const idx = line.indexOf(marker);
    if (idx >= 0 && idx < cut) cut = idx;
  }

  return line.slice(0, cut);
}

function parseCidr(input, family) {
  if (family === 4) return parseIpv4Cidr(input);
  return parseIpv6Cidr(input);
}

function parseIpv4Cidr(input) {
  const m = input.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (!m) return null;

  const ip = m[1];
  const prefix = Number(m[2]);
  if (prefix < 0 || prefix > 32) return null;

  const octets = ip.split(".").map(Number);
  if (octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;

  const value =
    BigInt(octets[0]) << 24n |
    BigInt(octets[1]) << 16n |
    BigInt(octets[2]) << 8n |
    BigInt(octets[3]);

  const hostBits = 32n - BigInt(prefix);
  const size = 1n << hostBits;
  const start = (value / size) * size;
  const end = start + size - 1n;

  const normalizedIp = [
    Number((start >> 24n) & 255n),
    Number((start >> 16n) & 255n),
    Number((start >> 8n) & 255n),
    Number(start & 255n)
  ].join(".");

  return {
    normalized: `${normalizedIp}/${prefix}`,
    range: { start, end, prefix }
  };
}

function parseIpv6Cidr(input) {
  const m = input.match(/^([0-9a-fA-F:.]+)\/(\d{1,3})$/);
  if (!m) return null;

  const ip = m[1].toLowerCase();
  const prefix = Number(m[2]);

  if (prefix < 0 || prefix > 128) return null;

  const value = ipv6ToBigInt(ip);
  if (value === null) return null;

  const hostBits = 128n - BigInt(prefix);
  const size = 1n << hostBits;
  const start = (value / size) * size;
  const end = start + size - 1n;

  return {
    normalized: `${bigIntToIpv6(start)}/${prefix}`,
    range: { start, end, prefix }
  };
}

function ipv6ToBigInt(ip) {
  if (!ip || ip.includes(":::")) return null;

  // 处理 IPv4-mapped IPv6 的简化场景；这里规则源一般不需要，但避免误判
  if (ip.includes(".")) return null;

  const parts = ip.split("::");
  if (parts.length > 2) return null;

  const left = parts[0] ? parts[0].split(":").filter(Boolean) : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(":").filter(Boolean) : [];

  if (left.length + right.length > 8) return null;

  const fill = Array(8 - left.length - right.length).fill("0");
  const groups = [...left, ...fill, ...right];

  if (groups.length !== 8) return null;

  let value = 0n;

  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    value = (value << 16n) + BigInt(parseInt(g, 16));
  }

  return value;
}

function bigIntToIpv6(value) {
  const groups = [];

  for (let i = 7; i >= 0; i--) {
    groups.push(Number((value >> BigInt(i * 16)) & 0xffffn).toString(16));
  }

  // 简单压缩最长的 0 段
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;

  for (let i = 0; i <= groups.length; i++) {
    if (i < groups.length && groups[i] === "0") {
      if (curStart === -1) curStart = i;
      curLen++;
    } else {
      if (curLen > bestLen) {
        bestStart = curStart;
        bestLen = curLen;
      }
      curStart = -1;
      curLen = 0;
    }
  }

  if (bestLen < 2) return groups.join(":");

  const before = groups.slice(0, bestStart).join(":");
  const after = groups.slice(bestStart + bestLen).join(":");

  if (!before && !after) return "::";
  if (!before) return `::${after}`;
  if (!after) return `${before}::`;
  return `${before}::${after}`;
}

function rangesOverlap(a, b) {
  return a.start <= b.end && b.start <= a.end;
}

function compareCidr(a, b, family) {
  const pa = parseCidr(a, family);
  const pb = parseCidr(b, family);

  if (pa.range.start < pb.range.start) return -1;
  if (pa.range.start > pb.range.start) return 1;

  return pa.range.prefix - pb.range.prefix;
}

function toSurge(cidrs, ruleName) {
  return cidrs.map(cidr => `${ruleName},${cidr}`).join("\n") + "\n";
}

function toMihomo(cidrs) {
  return "payload:\n" + cidrs.map(cidr => `  - ${cidr}`).join("\n") + "\n";
}

function mergeMeta(a, b) {
  return {
    ok: true,
    name: "cernet",
    count: (a.count || 0) + (b.count || 0),
    updatedAt: new Date().toISOString(),
    fromCache: Boolean(a.fromCache || b.fromCache),
    stale: Boolean(a.stale || b.stale)
  };
}

function textResponse(body, contentType, data) {
  return new Response(body, {
    headers: {
      "content-type": contentType,
      "cache-control": "private, max-age=3600, stale-while-revalidate=86400",
      "x-cernet-count": String(data.count ?? ""),
      "x-cernet-updated-at": data.updatedAt ?? "",
      "x-cernet-from-cache": String(Boolean(data.fromCache)),
      "x-cernet-stale": String(Boolean(data.stale))
    }
  });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2) + "\n", {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? "private, max-age=300" : "no-store"
    }
  });
}

function sanitizeConfig(config) {
  return {
    upstreams: config.upstreams,
    exclude4: config.exclude4,
    exclude6: config.exclude6,
    minCount: config.minCount,
    cacheKeys: config.cacheKeys
  };
}