#!/usr/bin/env bash
#
# Smoke tests for setup.sh. They use a temporary HOME and a fake pi binary,
# so they never touch the real Pi configuration or network.
#
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SETUP="$ROOT/setup.sh"
BUNDLED_FIT="$ROOT/plugins/FIT_pi"
BUNDLED_QUESTIONNAIRE="$ROOT/plugins/pi_questionare"
BUNDLED_FRESHMAKER="$ROOT/plugins/freshmaker"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

failures=0
case_dir=""
home=""
bin=""
log=""
git_log=""
clone_fixtures=""
out=""
err=""

pass() {
	printf 'ok - %s\n' "$1"
}

fail_test() {
	printf 'not ok - %s\n' "$1" >&2
	failures=$((failures + 1))
}

assert_file() {
	if [ -f "$1" ]; then pass "$2"; else fail_test "$2 (missing $1)"; fi
}

assert_no_file() {
	if [ ! -e "$1" ]; then pass "$2"; else fail_test "$2 (unexpected $1)"; fi
}

assert_contains() {
	local file="$1"
	local needle="$2"
	local message="$3"
	if grep -Fq -- "$needle" "$file"; then
		pass "$message"
	else
		fail_test "$message (missing '$needle' in $file)"
	fi
}

assert_equals() {
	if [ "$1" = "$2" ]; then pass "$3"; else fail_test "$3 (expected '$2', got '$1')"; fi
}

new_case() {
	case_dir=$(mktemp -d "$TMP/case.XXXXXX")
	home="$case_dir/home"
	bin="$case_dir/bin"
	log="$case_dir/pi.log"
	git_log="$case_dir/git.log"
	clone_fixtures="$case_dir/clones"
	out="$case_dir/out"
	err="$case_dir/err"

	mkdir -p "$home/dev/FIT_pi" "$home/dev/sin/pi_questionare/extensions" "$home/dev/pi-git-commands" "$bin"
	mkdir -p "$clone_fixtures/pi-git-commands"

	cat >"$home/dev/FIT_pi/package.json" <<'EOF'
{
  "name": "pi-fit",
  "pi": { "extensions": ["./src/index.ts"] }
}
EOF

	cat >"$home/dev/sin/pi_questionare/package.json" <<'EOF'
{
  "name": "@sloppymcslopperson/pi-questions",
  "pi": { "extensions": ["./extensions/questionnaire.ts"] }
}
EOF

	cat >"$home/dev/sin/pi_questionare/extensions/questionnaire.ts" <<'EOF'
export default function questionnaire() {
	return undefined;
}
EOF

	cat >"$home/dev/pi-git-commands/package.json" <<'EOF'
{
  "name": "@svyaddict/pi-git-commands",
  "pi": { "extensions": ["./extensions/index.ts"] }
}
EOF

	cp "$home/dev/pi-git-commands/package.json" "$clone_fixtures/pi-git-commands/package.json"

	cat >"$bin/pi" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$PI_LOG"
if [ -n "${FAKE_PI_FAIL_ON:-}" ] && [[ "$*" == *"$FAKE_PI_FAIL_ON"* ]]; then
	exit 1
fi
exit 0
EOF
	chmod +x "$bin/pi"

	cat >"$bin/git" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GIT_LOG"
if [ "$1" = clone ]; then
	url="$2"
	dest="$3"
	name=${url##*/}
	name=${name%.git}
	mkdir -p "$dest"
	cp -R "$GIT_CLONE_FIXTURES/$name/." "$dest/"
fi
exit 0
EOF
	chmod +x "$bin/git"
	: >"$log"
	: >"$git_log"
}

run_setup() {
	local status=0
	(
		export HOME="$home"
		export PATH="$bin:$PATH"
		export PI_LOG="$log"
		export GIT_LOG="$git_log"
		export GIT_CLONE_FIXTURES="$clone_fixtures"
		if [ -n "${FAKE_PI_FAIL_ON:-}" ]; then export FAKE_PI_FAIL_ON; fi
		if [ -n "${FIT_PI_SRC_OVERRIDE:-}" ]; then export FIT_PI_SRC="$FIT_PI_SRC_OVERRIDE"; fi
		if [ -n "${QUESTIONNAIRE_SRC_OVERRIDE:-}" ]; then export QUESTIONNAIRE_SRC="$QUESTIONNAIRE_SRC_OVERRIDE"; fi
		if [ -n "${GIT_COMMANDS_SRC_OVERRIDE:-}" ]; then export GIT_COMMANDS_SRC="$GIT_COMMANDS_SRC_OVERRIDE"; fi
		if [ -n "${FRESHMAKER_SRC_OVERRIDE:-}" ]; then export FRESHMAKER_SRC="$FRESHMAKER_SRC_OVERRIDE"; fi
		"$SETUP" "$@"
	) >"$out" 2>"$err" || status=$?
	return "$status"
}

test_install_packages() {
	new_case
	if ! run_setup --skip-update --yes; then
		fail_test "basic setup succeeds ($(cat "$err"))"
		return
	fi
	pass "basic setup succeeds"

	assert_contains "$log" "install $BUNDLED_FIT" "installs bundled FIT_pi"
	assert_contains "$log" "install $BUNDLED_QUESTIONNAIRE" "installs bundled questionnaire package"
	assert_contains "$log" "install $BUNDLED_FRESHMAKER" "installs bundled pi-freshmaker package"
	assert_contains "$log" "install $home/dev/pi-git-commands" "installs external pi-git-commands by discovered path"
	assert_no_file "$home/.pi/agent/extensions/questionnaire.ts" "does not copy a bare extension"
	if grep -q '^update' "$log"; then
		fail_test "--skip-update avoids update commands"
	else
		pass "--skip-update avoids update commands"
	fi
}

test_dry_run() {
	new_case
	if ! run_setup --dry-run --skip-update; then
		fail_test "dry run succeeds ($(cat "$err"))"
		return
	fi
	pass "dry run succeeds"
	assert_contains "$out" '[dry-run] would run:' "dry run prints planned commands"
	assert_contains "$out" "install $BUNDLED_FIT" "dry run prints planned FIT_pi install"
	if [ -s "$log" ]; then
		fail_test "dry run does not invoke pi"
	else
		pass "dry run does not invoke pi"
	fi
	assert_contains "$out" "install $BUNDLED_QUESTIONNAIRE" "dry run prints planned questionnaire install"
	assert_contains "$out" "install $BUNDLED_FRESHMAKER" "dry run prints planned pi-freshmaker install"
	assert_contains "$out" "install $home/dev/pi-git-commands" "dry run prints planned pi-git-commands install"
	assert_no_file "$home/.pi/agent/extensions/questionnaire.ts" "dry run does not write an extension copy"
}

test_update_order() {
	new_case
	if ! run_setup --yes; then
		fail_test "setup with updates succeeds ($(cat "$err"))"
		return
	fi
	pass "setup with updates succeeds"
	assert_equals "$(sed -n '1p' "$log")" 'update' "updates Pi first"
	assert_equals "$(sed -n '2p' "$log")" 'update --extensions' "updates packages second"
	assert_contains "$log" "install $BUNDLED_FIT" "installs FIT_pi after updates"
	local fit_line questionnaire_line freshmaker_line git_line
	fit_line=$(grep -n "install $BUNDLED_FIT" "$log" | cut -d: -f1)
	questionnaire_line=$(grep -n "install $BUNDLED_QUESTIONNAIRE" "$log" | cut -d: -f1)
	freshmaker_line=$(grep -n "install $BUNDLED_FRESHMAKER" "$log" | cut -d: -f1)
	git_line=$(grep -n "install $home/dev/pi-git-commands" "$log" | cut -d: -f1)
	assert_equals "$([ "$questionnaire_line" -gt "$fit_line" ] && echo yes || echo no)" 'yes' "installs questionnaire after FIT_pi"
	assert_equals "$([ "$freshmaker_line" -gt "$questionnaire_line" ] && echo yes || echo no)" 'yes' "installs pi-freshmaker after questionnaire"
	assert_equals "$([ "$git_line" -gt "$freshmaker_line" ] && echo yes || echo no)" 'yes' "installs pi-git-commands after pi-freshmaker"
}

test_idempotent_runs() {
	new_case
	if ! run_setup --skip-update; then
		fail_test "first idempotency run succeeds"
		return
	fi
	if ! run_setup --skip-update; then
		fail_test "second idempotency run succeeds"
		return
	fi
	pass "setup can run twice"

	local backups=0
	if [ -d "$home/.pi/agent/extensions" ]; then
		backups=$(find "$home/.pi/agent/extensions" -name '*.bak-*' -print | wc -l | tr -d ' ')
	fi
	assert_equals "$backups" '0' "no extension backups are created when there is no old copy"
}

test_package_switch() {
	new_case
	mkdir -p "$home/.pi/agent/extensions"
	printf 'old copy\n' >"$home/.pi/agent/extensions/questionnaire.ts"

	if ! run_setup --skip-update; then
		fail_test "package switch succeeds ($(cat "$err"))"
		return
	fi
	pass "package switch succeeds"
	assert_contains "$log" "install $BUNDLED_QUESTIONNAIRE" "installs questionnaire package"
	assert_no_file "$home/.pi/agent/extensions/questionnaire.ts" "removes old extension copy"
	local backups
	backups=$(find "$home/.pi/agent/extensions" -name '*.bak-*' -print | wc -l | tr -d ' ')
	assert_equals "$backups" '1' "backs up old extension before removal"
}

test_failure_is_fatal() {
	new_case
	if FAKE_PI_FAIL_ON=install run_setup --skip-update; then
		fail_test "install failure exits non-zero"
	else
		pass "install failure exits non-zero"
	fi
}

test_ambiguous_discovery() {
	new_case
	mkdir -p "$home/dev/other/pi-git-commands"
	cp "$home/dev/pi-git-commands/package.json" "$home/dev/other/pi-git-commands/package.json"
	if run_setup --dry-run --skip-update; then
		fail_test "ambiguous pi-git-commands discovery fails"
	else
		pass "ambiguous pi-git-commands discovery fails"
	fi
	assert_contains "$err" 'found multiple pi-git-commands package candidates' "ambiguous discovery explains the problem"
}

test_bundled_fit_default() {
	new_case
	if ! run_setup --dry-run --skip-update; then
		fail_test "bundled FIT_pi is used by default ($(cat "$err"))"
		return
	fi
	pass "bundled FIT_pi is used by default"
	assert_contains "$out" "FIT_pi: $BUNDLED_FIT" "does not use the temporary local FIT_pi checkout"
}

test_env_override() {
	new_case
	mv "$home/dev/FIT_pi" "$case_dir/custom-fit"
	if ! FIT_PI_SRC_OVERRIDE="$case_dir/custom-fit" run_setup --dry-run --skip-update; then
		fail_test "FIT_PI_SRC override succeeds ($(cat "$err"))"
		return
	fi
	pass "FIT_PI_SRC override succeeds"
	assert_contains "$out" "FIT_pi: $case_dir/custom-fit" "override path is used"
}

test_git_commands_env_override() {
	new_case
	mv "$home/dev/pi-git-commands" "$case_dir/custom-git-commands"
	if ! GIT_COMMANDS_SRC_OVERRIDE="$case_dir/custom-git-commands" run_setup --dry-run --skip-update; then
		fail_test "GIT_COMMANDS_SRC override succeeds ($(cat "$err"))"
		return
	fi
	pass "GIT_COMMANDS_SRC override succeeds"
	assert_contains "$out" "pi-git-commands: $case_dir/custom-git-commands" "git commands override path is used"
}

test_missing_package() {
	new_case
	if QUESTIONNAIRE_SRC_OVERRIDE="$home/missing-questionnaire" run_setup --dry-run --skip-update; then
		fail_test "missing questionnaire override fails"
	else
		pass "missing questionnaire override fails"
	fi
	assert_contains "$err" 'QUESTIONNAIRE_SRC is not a directory' "missing questionnaire override explains the problem"
}

test_bundled_questionnaire_default() {
	new_case
	if ! run_setup --dry-run --skip-update; then
		fail_test "bundled questionnaire is used by default ($(cat "$err"))"
		return
	fi
	pass "bundled questionnaire is used by default"
	assert_contains "$out" "Questionnaire: $BUNDLED_QUESTIONNAIRE" "uses the bundled questionnaire path"
}

test_freshmaker_env_override() {
	new_case
	mkdir -p "$case_dir/custom-freshmaker"
	cp "$BUNDLED_FRESHMAKER/package.json" "$case_dir/custom-freshmaker/package.json"
	if ! FRESHMAKER_SRC_OVERRIDE="$case_dir/custom-freshmaker" run_setup --dry-run --skip-update; then
		fail_test "FRESHMAKER_SRC override succeeds ($(cat "$err"))"
		return
	fi
	pass "FRESHMAKER_SRC override succeeds"
	assert_contains "$out" "pi-freshmaker: $case_dir/custom-freshmaker" "freshmaker override path is used"
}

test_invalid_git_commands_package() {
	new_case
	cat >"$home/dev/pi-git-commands/package.json" <<'EOF'
{
  "name": "some-other-package",
  "pi": { "extensions": ["./extensions/index.ts"] }
}
EOF
	if run_setup --dry-run --skip-update; then
		fail_test "pi-git-commands with the wrong package name fails"
	else
		pass "pi-git-commands with the wrong package name fails"
	fi
	assert_contains "$err" 'does not look valid' "wrong pi-git-commands package name explains the problem"
}

test_clone_missing_git_commands() {
	new_case
	rm -rf "$home/dev/pi-git-commands"
	if ! run_setup --skip-update; then
		fail_test "missing pi-git-commands is cloned ($(cat "$err"))"
		return
	fi
	pass "missing pi-git-commands is cloned"
	assert_contains "$git_log" "clone https://github.com/svyaddict/pi-git-commands.git $home/dev/pi-git-commands" "clones pi-git-commands from GitHub into HOME/dev"
	assert_contains "$log" "install $home/dev/pi-git-commands" "installs the cloned pi-git-commands checkout"
}

test_install_packages
test_dry_run
test_update_order
test_idempotent_runs
test_package_switch
test_failure_is_fatal
test_ambiguous_discovery
test_bundled_fit_default
test_missing_package
test_bundled_questionnaire_default
test_freshmaker_env_override
test_invalid_git_commands_package
test_clone_missing_git_commands
test_env_override
test_git_commands_env_override

if [ "$failures" -ne 0 ]; then
	printf '\n%s test(s) failed\n' "$failures" >&2
	exit 1
fi

printf '\nAll bash setup tests passed.\n'
