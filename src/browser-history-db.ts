import { DatabaseSync } from 'node:sqlite';
import type { HistoryBrowser, HistoryQuery, HistoryVisit, HistoryResults } from './contracts';
const pageSize = 100;
const iso = (value: unknown): string | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 8640000000000000) return null;
  return new Date(Math.trunc(value)).toISOString();
};
export function validateHistoryQuery(value: unknown): HistoryQuery {
  const q = value as HistoryQuery;
  if (!q || typeof q.sourceId !== 'string' || q.sourceId.length > 100 || typeof q.search !== 'string' || q.search.length > 2000 || !['all','http','https','other'].includes(q.protocol) || !['all','link','typed','reload','redirect','other'].includes(q.type) || !Number.isInteger(q.page) || q.page < 0 || q.page > 10000000) throw Error('Invalid browser history filters.');
  for (const date of [q.start,q.end]) if (typeof date !== 'string' || date.length > 40 || (date && !Number.isFinite(Date.parse(date)))) throw Error('Invalid history date filter.');
  if (q.start && q.end && Date.parse(q.start) >= Date.parse(q.end)) throw Error('End time must be after start time.');
  return { sourceId:q.sourceId, search:q.search, protocol:q.protocol, type:q.type, start:q.start, end:q.end, page:q.page };
}
export class HistoryDatabase {
  readonly browser: string;
  private db: DatabaseSync;
  private base: string;
  constructor(file: string, browser: HistoryBrowser) {
    this.db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
    try {
      this.db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA busy_timeout=1000;');
      const tables = new Set(this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(r=>r.name));
      const firefox = tables.has('moz_places') && tables.has('moz_historyvisits');
      const chromium = tables.has('urls') && tables.has('visits');
      if ((!firefox && !chromium) || (firefox && chromium)) throw Error('Unsupported history schema. Select a Chrome/Edge History or Firefox places.sqlite database.');
      if ((browser === 'firefox' && !firefox) || (['chrome','edge'].includes(browser) && !chromium)) throw Error('Selected browser does not match the database. Choose Auto detect or the correct browser.');
      this.browser = firefox ? 'Firefox' : browser === 'chrome' ? 'Chrome' : browser === 'edge' ? 'Edge' : 'Chromium (Chrome / Edge)';
      const columns = (table: string) => new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(r=>r.name));
      const u = columns(firefox?'moz_places':'urls'), v = columns(firefox?'moz_historyvisits':'visits');
      const requiredU = ['id','url'];
      const requiredV = firefox ? ['id','place_id','visit_date'] : ['id','url','visit_time'];
      if (!requiredU.every(k=>u.has(k)) || !requiredV.every(k=>v.has(k))) throw Error('History database is missing required columns.');
      const rawTime = firefox ? 'v.visit_date' : 'v.visit_time';
      const rawType = v.has(firefox?'visit_type':'transition') ? (firefox?'v.visit_type':'(v.transition & 255)') : 'NULL';
      const type = firefox ? `CASE ${rawType} WHEN 1 THEN 'link' WHEN 2 THEN 'typed' WHEN 9 THEN 'reload' WHEN 5 THEN 'redirect' WHEN 6 THEN 'redirect' ELSE 'other' END` : `CASE WHEN (${v.has('transition') ? 'v.transition' : '0'} & 3221225472) != 0 THEN 'redirect' ELSE CASE ${rawType} WHEN 0 THEN 'link' WHEN 1 THEN 'typed' WHEN 8 THEN 'reload' ELSE 'other' END END`;
      const join = firefox ? 'moz_historyvisits v JOIN moz_places u ON u.id=v.place_id' : 'visits v JOIN urls u ON u.id=v.url';
      const refJoin = v.has('from_visit') ? (firefox ? 'LEFT JOIN moz_historyvisits previous ON previous.id=v.from_visit LEFT JOIN moz_places ref ON ref.id=previous.place_id' : 'LEFT JOIN visits previous ON previous.id=v.from_visit LEFT JOIN urls ref ON ref.id=previous.url') : '';
      this.base = `SELECT CAST(v.id AS TEXT) AS id, u.url AS url, ${u.has('title')?"COALESCE(u.title,'')":"''"} AS title,
        CASE WHEN ${rawTime}>0 THEN CAST(${rawTime}/1000 AS INTEGER) - ${firefox?0:11644473600000} END AS timeMs,
        CAST(${rawTime} AS TEXT) AS rawTime, ${type} AS type,
        ${v.has(firefox?'visit_type':'transition') ? `CAST(${firefox?'v.visit_type':'v.transition'} AS TEXT)` : 'NULL'} AS rawType,
        ${u.has('visit_count')?'CAST(u.visit_count AS REAL)':'NULL'} AS urlVisits,
        ${!firefox && v.has('visit_duration')?'CASE WHEN v.visit_duration>=0 THEN v.visit_duration/1000000.0 END':'NULL'} AS durationSeconds,
        ${refJoin ? "COALESCE(ref.url,'')" : "''"} AS referrer FROM ${join} ${refJoin}`;
      // Prepare immediately so malformed imports cannot replace a working collection.
      this.db.prepare(`SELECT * FROM (${this.base}) LIMIT 0`).all();
    } catch(error) { this.db.close(); throw error; }
  }
  private where(q: HistoryQuery): { sql: string; params: (string|number)[] } {
    const clauses = ['1=1'], params: (string|number)[] = [];
    if(q.search){ clauses.push("(instr(lower(COALESCE(url,'')),lower(?))>0 OR instr(lower(title),lower(?))>0)"); params.push(q.search,q.search); }
    if(q.protocol==='other') clauses.push("lower(url) NOT LIKE 'https:%' AND lower(url) NOT LIKE 'http:%'");
    else if(q.protocol!=='all'){ clauses.push('lower(url) LIKE ?'); params.push(q.protocol+':%'); }
    if(q.type!=='all'){ clauses.push('type=?'); params.push(q.type); }
    if(q.start){ clauses.push('timeMs>=?'); params.push(Date.parse(q.start)); }
    if(q.end){ clauses.push('timeMs<?'); params.push(Date.parse(q.end)); }
    return { sql:clauses.join(' AND '),params };
  }
  private row(r: Record<string, unknown>): HistoryVisit {
    const url = String(r.url ?? ''); let domain = '';
    try { domain = new URL(url).hostname; } catch { /* Preserve nonstandard URLs verbatim. */ }
    return { id:String(r.id), url, domain, title:String(r.title ?? ''), time:iso(r.timeMs), rawTime:String(r.rawTime ?? ''), type:String(r.type), rawType:String(r.rawType ?? ''), urlVisits:typeof r.urlVisits==='number'?r.urlVisits:null, durationSeconds:typeof r.durationSeconds==='number'?r.durationSeconds:null, referrer:String(r.referrer ?? '') };
  }
  query(q: HistoryQuery): HistoryResults {
    const {sql,params}=this.where(q);
    const stats=this.db.prepare(`SELECT count(*) AS total,count(DISTINCT url) AS pages,min(timeMs) AS first,max(timeMs) AS last FROM (${this.base}) WHERE ${sql}`).get(...params)!;
    const page=Math.min(q.page,Math.max(0,Math.ceil(Number(stats.total)/pageSize)-1));
    const rows=this.db.prepare(`SELECT * FROM (${this.base}) WHERE ${sql} ORDER BY timeMs DESC,CAST(id AS INTEGER) DESC LIMIT ? OFFSET ?`).all(...params,pageSize,page*pageSize).map(r=>this.row(r));
    return {sourceId:q.sourceId,total:Number(stats.total),pages:Number(stats.pages),first:iso(stats.first),last:iso(stats.last),page,rows};
  }
  copy(q: HistoryQuery, mode: 'urls'|'visits', visitId?: string): { text: string; count: number } {
    const {sql,params}=this.where(q);
    if (visitId !== undefined) { if(typeof visitId!=='string'||visitId.length>100) throw Error('Invalid visit.'); params.push(visitId); }
    const rows=this.db.prepare(`SELECT ${mode==='urls'?'DISTINCT url':'*'} FROM (${this.base}) WHERE ${sql}${visitId !== undefined?' AND id=?':''} ORDER BY ${mode==='urls'?'url':'timeMs DESC,CAST(id AS INTEGER) DESC'} LIMIT 10001`).all(...params);
    if(rows.length>10000) throw Error('More than 10,000 results. Narrow the filters before copying.');
    if(!rows.length) throw Error('No matching visits to copy.');
    if(mode==='urls') return {text:rows.map(r=>String(r.url??'')).join('\r\n'),count:rows.length};
    const cell=(v: unknown) => { let text=String(v??'').replace(/[\t\r\n]+/g,' '); if(/^[\s]*[=+@-]/.test(text))text="'"+text; return text; };
    const headers=['Time (UTC)','URL','Title','Domain','Type','URL visits (database)','Duration (seconds)','Referrer','Raw timestamp','Raw type'];
    return {text:[headers,...rows.map(r=>{const v=this.row(r);return [v.time,v.url,v.title,v.domain,v.type,v.urlVisits,v.durationSeconds,v.referrer,v.rawTime,v.rawType];})].map(row=>row.map(cell).join('\t')).join('\r\n'),count:rows.length};
  }
  close(): void { this.db.close(); }
}
