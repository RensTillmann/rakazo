import { describe, expect, it } from "vitest";
import { todoCheckShellRefusal } from "./todo-check-shell.js";

describe("the read-only shell of a scheduled to-do check", () => {
  it.each([
    "gh api repos/acme/site/collaborators/elena-bot/permission",
    "gh api -X GET repos/acme/site",
    "gh api --method=GET repos/acme/site --jq .permissions",
    "gh api -H 'Accept: application/vnd.github+json' repos/acme/site --paginate",
    "gh-app-login",
    "git ls-remote https://github.com/acme/site HEAD",
    "dig +short TXT rakazo.dev",
    "nslookup -type=TXT _dmarc.rakazo.dev",
    "host k1._domainkey.rakazo.dev",
    "curl -sSL https://rakazo.dev/.well-known/security.txt",
    "curl -I https://rakazo.dev",
    "curl -X HEAD https://rakazo.dev",
    "curl --request=GET -H 'Accept: text/plain' https://rakazo.dev",
    "cat /etc/os-release",
    "ls -la ~/repos",
    "gh api repos/acme/site | jq '.permissions.push' | head -n 1",
    "grep -c 'v=spf1' notes.txt",
    "tail -n 20 log.txt | wc -l",
    `jq -r '.items[] | select(.name == "x") | .id' data.json`,
  ])("runs %s", (command) => {
    expect(todoCheckShellRefusal(command)).toBeUndefined();
  });

  it.each([
    ["gh api -X POST repos/acme/site/issues", "gh api -X POST"],
    ["gh api -XPATCH repos/acme/site", "gh api -X PATCH"],
    ["gh api -iXDELETE repos/acme/site", "gh api -X DELETE"],
    ["gh api --method=PATCH repos/acme/site", "gh api --method PATCH"],
    ["gh api --method PUT repos/acme/site/topics", "gh api --method PUT"],
    ["gh api repos/acme/site/issues -f title=x", "gh api -f"],
    ["gh api repos/acme/site/issues -Ftitle=x", "gh api -F"],
    ["gh api repos/acme/site/issues --raw-field title=x", "gh api --raw-field"],
    ["gh api repos/acme/site --input body.json", "gh api --input"],
    ["gh api graphql", "gh api graphql"],
    ["gh api -H 'X-HTTP-Method-Override: DELETE' repos/acme/site", "gh api method override header"],
    ["gh repo delete acme/site --yes", "gh repo"],
    ["gh-app-login --force", "gh-app-login with arguments"],
    ["curl -d x=1 https://rakazo.dev", "curl -d"],
    ["curl -sd x=1 https://rakazo.dev", "curl -sd"],
    ["curl --data-binary @f https://rakazo.dev", "curl --data-binary"],
    ["curl --da=x https://rakazo.dev", "curl --da"],
    ["curl -X POST https://rakazo.dev", "curl -X POST"],
    ["curl --request=DELETE https://rakazo.dev", "curl --request DELETE"],
    ["curl -T file https://rakazo.dev", "curl -T"],
    ["curl -F a=@f https://rakazo.dev", "curl -F"],
    ["curl -o out.html https://rakazo.dev", "curl -o"],
    ["curl -sSo out.html https://rakazo.dev", "curl -sSo"],
    ["curl -O https://rakazo.dev/x", "curl -O"],
    ["curl --output=x https://rakazo.dev", "curl --output"],
    ["curl -K evil.conf", "curl -K"],
    ["curl gopher://127.0.0.1:6379/_FLUSHALL", "curl gopher://"],
    ["curl --url=dict://127.0.0.1:11211/", "curl dict://"],
    ["cat x > y", "the operator >"],
    ["cat x >> y", "the operator >"],
    ["cat x | tee y", "tee"],
    ["ls; rm -rf ~", "the operator ;"],
    ["ls && rm -rf ~", "the operator &"],
    ["ls || rm -rf ~", "the operator ||"],
    ["ls & rm -rf ~", "the operator &"],
    ["cat $(rm -rf ~)", "a variable or command substitution"],
    ['cat "$(rm -rf ~)"', "an expansion inside double quotes"],
    ["cat `rm -rf ~`", "a command substitution"],
    ["cat $HOME/x", "a variable or command substitution"],
    ["cat x\nrm -rf ~", "the operator newline"],
    ["cat <(rm -rf ~)", "the operator <"],
    ["(rm -rf ~)", "the operator ("],
    ["rm -rf ~", "rm"],
    ["/bin/rm x", "/bin/rm"],
    ["FOO=1 cat x", "FOO=1"],
    ["git push origin main", "git push"],
    ["git -c core.sshCommand=x ls-remote origin", "git -c"],
    ["git ls-remote --upload-pack='touch x' origin", "git ls-remote --upload-pack"],
    ["git ls-remote 'ext::sh -c touch% x'", "git ls-remote command transport"],
    ["cat 'unterminated", "an unterminated quote"],
    ["cat x |", "an empty pipeline stage"],
  ])("refuses %s", (command, reason) => {
    expect(todoCheckShellRefusal(command)).toBe(reason);
  });

  it("refuses an allowlisted word that is only quoted to look like one", () => {
    expect(todoCheckShellRefusal("'gh' api -X POST x")).toBe("gh api -X POST");
    expect(todoCheckShellRefusal("c\\at x > y")).toBe("the operator >");
  });
});
