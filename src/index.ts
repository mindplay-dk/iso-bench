import { MultiWorker } from "./MultiWorker";

type Copy<T> = T extends Array<T> ? T : T; // Workaround to avoid empty scope arguments failing types

type ScriptData = {
    name:string;
    samples:number;
    opMs:number;
    totalTime:number;
    cycles:number;
    script:{
        body:string;
        args:string[];
        evalArgs:string;
    },
    log?:any[];
};
type LogData = {
    log:any[];
};
type OutputData = {
    log:any[];
    clear:boolean;
};
function isScriptData(res:ScriptData|LogData|OutputData):res is ScriptData {
    return "script" in res;
}
function isOutputData(res:ScriptData|LogData|OutputData):res is OutputData {
    return "clear" in res;
}

function processFunction(fn:(...args:any[])=>any) {
    let body = fn.toString();
    let args = body.substring(body.indexOf("(") + 1, body.indexOf(")")).split(",").map(el => el.trim()).filter(el => !!el);
    if (body.startsWith("function")) {
        body = body.substring(body.indexOf("{") + 1, body.lastIndexOf("}")).trim();
    } else {
        body = body.substring(body.indexOf("=>") + 2).trim();
        if (body.startsWith("{") && body.endsWith("}")) {
            body = body.substring(1, body.length-1).trim();
        }
    }
    let evalArgs:string[] = [];
    for (let i = 0; i < args.length; i++) {
        evalArgs.push(`let ${args[i]} = _args_ñ[${i}];`);
    }
    return { args, body, evalArgs: evalArgs.join("\r\n") };
}

export namespace IsoBench {
    export enum STRINGS {
        WORSE = "WORSE",
        BEST = "BEST",
        COMPLETED = "[TESTS COMPLETED]"
    };
    export type ScopeOptions = {
        parallel?:number;
        ms?:number;
        minMs?:number;
    };
    export class Scope<T_ARGS extends any[], T_SCOPE extends readonly any[]> {
        private _args;
        private _setup
        private _scripts:(ScriptData)[] = [];
        private _doneScripts:ScriptData[] = [];
        private _loggedScripts = new Set<ScriptData>()
        private _logData:(ScriptData|LogData|OutputData)[] = [];
        private _running = 0;
        private _endCb:(() => void) | null = null;;
        readonly options:Required<ScopeOptions>;
        started = false;
        constructor(options:ScopeOptions = {}, _setup?:(...args:Copy<T_ARGS>) => Promise<T_SCOPE>|T_SCOPE, ...args:T_ARGS) {
            this.options = {
                parallel: 1,
                ms: 1000,
                minMs: 1000,
                ...options
            };
            this._setup = _setup ? `let _args_ñ = await eval(${String(_setup)})(..._data_ñ.args);` : "";
            this._args = args;
        }
        add(name:string, cb:(...args:T_SCOPE)=>any) {
            let data:ScriptData = {
                name: name,
                samples: 0,
                opMs: -1,
                totalTime: 0,
                cycles: 100,
                script: processFunction(cb)
            };
            this._scripts.push(data);
            this._logData.push(data);
            return this;
        }
        log(...log:any[]) {
            this._logData.push({
                log: log
            });
            return this;
        }
        output(...log:any[]) {
            this._logData.push({
                log: log,
                clear: false
            });
            return this;
        }
        result(...log:any[]) {
            this._logData.push({
                log: log,
                clear: true
            });
            return this;
        }
        run() {
            return new Promise<void>((resolve, reject) => {
                if (!this.started) {
                    this.started = true;
                    this._endCb = resolve;
                    this._checkOutput();
                    this._next();
                } else {
                    reject(new Error("Already running"));
                }
            });
        }
        private _logPack(clear:boolean) {
            let toLog = this._doneScripts.slice();
            if (!clear) {
                for (let script of this._loggedScripts) {
                    toLog.splice(toLog.indexOf(script), 1);
                }
            }
            let ops = toLog.map(el => el.opMs);
            let min = Math.min(...ops.filter(n => !!n));
            let max = Math.max(...ops.filter(n => !!n));
            for (let data of toLog) {
                this._loggedScripts.add(data);
                if (clear && data.opMs > 0) {
                    data.log!.push(`${(data.opMs / min).toFixed(3)}x`);
                    data.log!.push(`${data.opMs === min ? STRINGS.WORSE : ""}${data.opMs === max ? STRINGS.BEST : ""}`);
                }
                console.log(...data.log!);
            }
            if (clear) {
                this._doneScripts.splice(0);
                this._loggedScripts.clear();
            }
        }
        private _checkOutput() {
            while (this._logData.length > 0 && this._logData[0].log) {
                if (!isScriptData(this._logData[0]) && this._logData[0].log.length > 0) {
                    console.log(...this._logData[0].log);
                }
                if (isOutputData(this._logData[0])) {
                    this._logPack(this._logData[0].clear);
                }
                this._logData.shift();
            }
        }
        private _next() {
            if (this._running < this.options.parallel) {
                let data = this._scripts.shift();
                if (data) {
                    this._runWorker(data);
                } else {
                    this._logPack(false);
                    console.log(STRINGS.COMPLETED);
                    this._endCb && this._endCb();
                }
            }
        }
        private _getWorkerScript(data:ScriptData) {
            return `parent.addEventListener("message", async _event_ñ => {
                try {
                    const _data_ñ = _d_ñ(_event_ñ.data || _event_ñ);
                    ${this._setup}
                    ${data.script.evalArgs}
                    const _n_ñ = _now_ñ();
                    for (let _i_ñ = 0; _i_ñ < ${data.cycles}; _i_ñ++) {
                        ${data.script.body}
                    }
                    const _diff_ñ = _dif_ñ(_n_ñ);
                    parent.postMessage({ diff: _diff_ñ });
                } catch (e) {
                    parent.postMessage({ error: String(e) });
                }
                close();
            });`;
        }
        private _checkDataResult(data:ScriptData, result:{log:string}|{error:string}|{diff:number}) {
            if ("log" in result) {
                console.log(...result.log);
                return;
            } else {
                this._running--;
                if ("error" in result) {
                    data.log = [data.name, "-", result.error];
                    data.opMs = 0;
                    this._doneScripts.push(data);
                    this._checkOutput();
                } else {
                    let ms = result.diff;
                    if (ms < this.options.minMs) {
                        let r = this.options.minMs / ms;
                        data.cycles = Math.round(data.cycles * (r || this.options.minMs));
                        this._scripts.unshift(data);
                    } else {
                        data.samples++;
                        let ops = data.cycles / ms;
                        data.opMs = data.opMs < 0 ? ops : (data.opMs + ops) / 2;
                        data.totalTime += ms;
                        if (data.totalTime > this.options.ms) {
                            data.log = [data.name, "-", Math.round(data.opMs*1000).toLocaleString(), "op/s.", data.samples, "workers in", Math.round(data.totalTime), "ms."];
                            this._doneScripts.push(data);
                            this._checkOutput();
                        } else {
                            this._scripts.unshift(data);
                        }
                    }
                }
                this._next();
            }
        }
        private _runWorker(data:ScriptData) {
            this._running++;
            let worker = new MultiWorker(this._getWorkerScript(data));
            worker.addEventListener("message", event => {
                if (!event.data) {
                    this._checkDataResult(data, event as any); // as any because of dom typings
                } else {
                    this._checkDataResult(data, event.data);
                }
            });
            worker.addEventListener("error", console.error);
            worker.postMessage({
                args: this._args || []
            });
        }
    }
}