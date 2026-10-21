/**
 * Fleet: the shell a scheduled to-do check (`todo_check` run) may use. Read-only in fact, not by
 * instruction: the command is tokenized here (no shell is consulted) and runs only when every
 * command of a plain pipeline is on a small allowlist with read-only arguments. Redirection,
 * command lists, substitution, variables, subshells and background jobs are refused outright.
 */

/** What a refused check records as its "couldn't check" reason. */
export const TODO_CHECK_SHELL_REASON = "needs a command that may change something";

type Words = readonly string[];

/**
 * Splits `command` into the words of each pipeline stage, or returns a refusal. Single quotes are
 * literal; double quotes may not contain `$`, a backtick or a backslash; outside quotes a
 * backslash escapes one character. Any shell operator other than a single `|` is refused.
 */
function pipelineStages(command: string): Words[] | string {
  const stages: string[][] = [[]];
  let word: string | undefined;
  const push = () => {
    if (word !== undefined) stages.at(-1)!.push(word);
    word = undefined;
  };
  for (let index = 0; index < command.length; index += 1) {
    const c = command[index]!;
    if (c === "'") {
      const end = command.indexOf("'", index + 1);
      if (end < 0) return "an unterminated quote";
      word = (word ?? "") + command.slice(index + 1, end);
      index = end;
      continue;
    }
    if (c === '"') {
      const end = command.indexOf('"', index + 1);
      if (end < 0) return "an unterminated quote";
      const inner = command.slice(index + 1, end);
      if (/[$`\\]/.test(inner)) return "an expansion inside double quotes";
      word = (word ?? "") + inner;
      index = end;
      continue;
    }
    if (c === "\\") {
      const next = command[index + 1];
      if (next === undefined || next === "\n") return "a line continuation";
      word = (word ?? "") + next;
      index += 1;
      continue;
    }
    if (c === " " || c === "\t") {
      push();
      continue;
    }
    if (c === "|") {
      if (command[index + 1] === "|" || command[index + 1] === "&")
        return `the operator ${c}${command[index + 1]}`;
      push();
      if (stages.at(-1)!.length === 0) return "an empty pipeline stage";
      stages.push([]);
      continue;
    }
    if (c === "$") return "a variable or command substitution";
    if (c === "`") return "a command substitution";
    if (/[;&<>(){}\n\r!]/.test(c))
      return `the operator ${c === "\n" || c === "\r" ? "newline" : c}`;
    if (c === "#" && word === undefined) return "a comment";
    word = (word ?? "") + c;
  }
  push();
  if (stages.some((stage) => stage.length === 0)) return "an empty pipeline stage";
  return stages;
}

function isGetMethod(value: string | undefined, also: readonly string[] = []): boolean {
  return value !== undefined && ["GET", ...also].includes(value.toUpperCase());
}

/** `gh api` with GET only: no other method, no body fields or input, no GraphQL. */
function ghApiRefusal(args: Words): string | undefined {
  const shortWithValue = new Set(["H", "p", "q", "t", "X", "f", "F"]);
  let endpoint: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") {
      endpoint ??= args[index + 1];
      break;
    }
    if (arg.startsWith("--")) {
      const [name, inline] = arg.split(/=(.*)/s, 2) as [string, string | undefined];
      if (["--field", "--raw-field", "--input"].includes(name)) return `gh api ${name}`;
      if (name === "--method") {
        const value = inline ?? args[++index];
        if (!isGetMethod(value)) return `gh api --method ${value ?? ""}`.trim();
        continue;
      }
      if (
        name === "--header" ||
        name === "--jq" ||
        name === "--template" ||
        name === "--preview" ||
        name === "--hostname" ||
        name === "--cache"
      ) {
        const value = inline ?? args[++index];
        if (name === "--header" && /method-override/i.test(value ?? ""))
          return "gh api method override header";
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      for (let at = 1; at < arg.length; at += 1) {
        const letter = arg[at]!;
        if (letter === "f" || letter === "F") return `gh api -${letter}`;
        if (!shortWithValue.has(letter)) continue;
        const value = arg.slice(at + 1) || args[++index];
        if (letter === "X" && !isGetMethod(value)) return `gh api -X ${value ?? ""}`.trim();
        if (letter === "H" && /method-override/i.test(value ?? ""))
          return "gh api method override header";
        break;
      }
      continue;
    }
    endpoint ??= arg;
  }
  if (!endpoint) return "gh api without an endpoint";
  if (/^\/?graphql\b/i.test(endpoint)) return "gh api graphql";
  return undefined;
}

const CURL_BOOLEAN_SHORT = new Set([
  "s",
  "S",
  "L",
  "f",
  "k",
  "I",
  "i",
  "v",
  "4",
  "6",
  "G",
  "N",
  "q",
  "l",
  "j",
]);
const CURL_VALUE_SHORT = new Set([
  "H",
  "A",
  "e",
  "m",
  "u",
  "b",
  "x",
  "r",
  "X",
  "E",
  "U",
  "Y",
  "y",
  "z",
]);
/** Long options that send data, write files, read a config or start another transfer. */
const CURL_REFUSED_LONG = [
  "--data",
  "--data-ascii",
  "--data-binary",
  "--data-raw",
  "--data-urlencode",
  "--json",
  "--upload-file",
  "--form",
  "--form-string",
  "--output",
  "--output-dir",
  "--remote-name",
  "--remote-name-all",
  "--remote-header-name",
  "--config",
  "--dump-header",
  "--cookie-jar",
  "--trace",
  "--trace-ascii",
  "--stderr",
  "--libcurl",
  "--create-dirs",
  "--ftp-create-dirs",
  "--write-out",
  "--hsts",
  "--alt-svc",
  "--etag-save",
  "--next",
  "--mail-from",
  "--mail-rcpt",
  "--quote",
  "--post301",
  "--post302",
  "--post303",
];

/** `curl` for GET or HEAD over http(s) only, writing nothing but its standard output. */
function curlRefusal(args: Words): string | undefined {
  const end = args.indexOf("--");
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const operand = (end >= 0 && index > end) || !arg.startsWith("-") || arg === "-";
    if (operand) {
      if (arg.includes("://") && !/^https?:\/\//i.test(arg))
        return `curl ${arg.split("://")[0]}://`;
      continue;
    }
    if (arg === "--") continue;
    if (arg.startsWith("--")) {
      const [name, inline] = arg.split(/=(.*)/s, 2) as [string, string | undefined];
      if (inline?.includes("://") && !/^https?:\/\//i.test(inline)) {
        return `curl ${inline.split("://")[0]}://`;
      }
      if ("--header".startsWith(name) && name.length > 3) {
        const value = inline ?? args[++index];
        if (/method-override/i.test(value ?? "")) return "curl method override header";
        continue;
      }
      // curl takes unambiguous prefixes, so a prefix of a refused option is refused too.
      if (
        name.length > 3 &&
        CURL_REFUSED_LONG.some((refused) => refused.startsWith(name) || name.startsWith(refused))
      ) {
        return `curl ${name}`;
      }
      if ("--request".startsWith(name) && name.length > 3) {
        const value = inline ?? args[++index];
        if (!isGetMethod(value, ["HEAD"])) return `curl --request ${value ?? ""}`.trim();
      }
      continue;
    }
    const letter = arg[1]!;
    const rest = arg.slice(2);
    if (CURL_BOOLEAN_SHORT.has(letter)) {
      if ([...rest].every((c) => CURL_BOOLEAN_SHORT.has(c))) continue;
      return `curl ${arg}`;
    }
    if (CURL_VALUE_SHORT.has(letter)) {
      const value = rest || args[++index];
      if (letter === "X" && !isGetMethod(value, ["HEAD"])) return `curl -X ${value ?? ""}`.trim();
      if (letter === "H" && /method-override/i.test(value ?? ""))
        return "curl method override header";
      continue;
    }
    return `curl -${letter}`;
  }
  return undefined;
}

/** `git ls-remote` alone, without an upload-pack program or a command transport. */
function gitRefusal(args: Words): string | undefined {
  if (args[0] !== "ls-remote") return `git ${args[0] ?? ""}`.trim();
  for (const arg of args.slice(1)) {
    if (arg.startsWith("--u")) return "git ls-remote --upload-pack";
    if (/^ext::|^fd::/i.test(arg)) return "git ls-remote command transport";
  }
  return undefined;
}

/** Programs whose every argument only reads (they cannot write a file or run a command). */
const READ_ONLY_PROGRAMS = new Set([
  "cat",
  "ls",
  "head",
  "tail",
  "grep",
  "jq",
  "wc",
  "dig",
  "nslookup",
  "host",
]);

function stageRefusal(words: Words): string | undefined {
  const [program, ...args] = words;
  if (!program) return "an empty command";
  if (READ_ONLY_PROGRAMS.has(program)) {
    // jq's --rawfile/--slurpfile only read; grep and the rest have no write option.
    return undefined;
  }
  if (program === "gh")
    return args[0] === "api" ? ghApiRefusal(args.slice(1)) : `gh ${args[0] ?? ""}`.trim();
  if (program === "curl") return curlRefusal(args);
  if (program === "git") return gitRefusal(args);
  // Signs gh in as this bot's GitHub App: writes only its gh token cache, the expiry stamp
  // beside it and gh's git credential helper line, then prints the repositories it can read.
  if (program === "gh-app-login")
    return args.length === 0 ? undefined : "gh-app-login with arguments";
  return program;
}

/**
 * Why a `todo_check` run may not run `command`, or undefined when every pipeline stage is a
 * read-only allowlisted command.
 */
export function todoCheckShellRefusal(command: string): string | undefined {
  const stages = pipelineStages(command.trim());
  if (typeof stages === "string") return stages;
  for (const stage of stages) {
    const refusal = stageRefusal(stage);
    if (refusal) return refusal;
  }
  return undefined;
}
