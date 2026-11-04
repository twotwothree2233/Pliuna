import { randomUUID } from 'node:crypto'

// Convert before the native JS bridge loses set/frozenset identity. All output is untrusted data.
export function encodedProgram(code: string): string {
  const prefix = '_trellis_' + randomUUID().replaceAll('-', '')
  return `def ${prefix}_run():
    result = None
${code.split('\n').map(line => '    ' + line).join('\n')}
    return result
${prefix}_value = ${prefix}_run()
import json as ${prefix}_json
import math as ${prefix}_math
def ${prefix}_encode(v, active):
    t = type(v)
    if v is None or t is bool or t is str:
        return {"type":"json","value":v}
    if t is int:
        if -9007199254740991 <= v <= 9007199254740991:
            return {"type":"json","value":v}
        return {"type":"bigint","decimal":str(v)}
    if t is float:
        if ${prefix}_math.isfinite(v):
            if (v == 0 and ${prefix}_math.copysign(1.0,v) < 0) or (abs(v) > 9007199254740991 and v == int(v)):
                raise ValueError("MONTY_NONFAITHFUL_FLOAT")
            return {"type":"json","value":v}
        return {"type":"nonfinite","value":"nan" if ${prefix}_math.isnan(v) else ("positive_infinity" if v > 0 else "negative_infinity")}
    if t is bytes:
        return {"type":"bytes","hex":v.hex()}
    if t not in (list,tuple,set,frozenset,dict):
        raise ValueError("MONTY_VALUE_UNSUPPORTED")
    identity = id(v)
    if identity in active:
        raise ValueError("MONTY_CYCLIC_VALUE")
    branch = active + [identity]
    if t is dict:
        entries = [{"key":${prefix}_encode(k,branch),"value":${prefix}_encode(x,branch)} for k,x in v.items()]
        if all(type(k) is str for k in v) and all(e["value"]["type"] == "json" for e in entries):
            return {"type":"json","value":{k:e["value"]["value"] for k,e in zip(v,entries)}}
        return {"type":"map","entries":entries}
    items = [${prefix}_encode(x,branch) for x in v]
    if t is list and all(x["type"] == "json" for x in items):
        return {"type":"json","value":[x["value"] for x in items]}
    tag = "list" if t is list else ("tuple" if t is tuple else ("set" if t is set else "frozenset"))
    return {"type":tag,"items":items}
try:
    ${prefix}_encoded = {"ok":True,"value":${prefix}_encode(${prefix}_value,[])}
except ValueError as ${prefix}_error:
    ${prefix}_reason = str(${prefix}_error)
    ${prefix}_encoded = {"ok":False,"error":${prefix}_reason if ${prefix}_reason in ("MONTY_NONFAITHFUL_FLOAT","MONTY_CYCLIC_VALUE","MONTY_VALUE_UNSUPPORTED") else "MONTY_ENCODING_FAILED"}
except Exception:
    ${prefix}_encoded = {"ok":False,"error":"MONTY_ENCODING_FAILED"}
${prefix}_json.dumps(${prefix}_encoded,allow_nan=False,ensure_ascii=False)
`
}
