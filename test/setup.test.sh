#!/usr/bin/env bash
#
# Smoke tests for setup.sh. They use a temporary HOME and a fake pi binary,
# so they never touch the real Pi configuration or network.
#
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SETUP="$ROOT/setup.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

failures=0
case_dir=""
home=""
bin=""
log=""
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
	out="$case_dir/out"
	err="$case_dir/err"

	mkdir -p "$home/dev/FIT_pi" "$home/dev/sin/pi_questionare" "$bin"

	cat >"$home/dev/FIT_pi/package.json" <<'EOF'
{
  "name": "pi-fit",
  "pi": { "extensions": ["./src/index.ts"] }
}
EOF

	cat >"$home/dev/sin/pi_questionare/questionnaire.ts" <<'EOF'
export default function questionnaire() {
	return undefined;
}
EOF

	cat >"$bin/pi" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$PI_LOG"
if [ -n "${FAKE_PI_FAIL_ON:-}" ] && [[ "$*" == *"$FAKE_PI_FAIL_ON"* ]]; then
	exit 1
fi
exit 0
EOF
	chmod +x "$bin/pi"
	: >"$log"
}

run_setup() {
	local status=0
	(
		export HOME="$home"
		export PATH="$bin:$PATH"
		export PI_LOG="$log"
		if [ -n "${FAKE_PI_FAIL_ON:-}" ]; then export FAKE_PI_FAIL_ON; fi
		if [ -n "${FIT_PI_SRC_OVERRIDE:-}" ]; then export FIT_PI_SRC="$FIT_PI_SRC_OVERRIDE"; fi
		if [ -n "${QUESTIONNAIRE_SRC_OVERRIDE:-}" ]; then export QUESTIONNAIRE_SRC="$QUESTIONNAIRE_SRC_OVERRIDE"; fi
		"$SETUP" "$@"
	) >"$out" 2>"$err" || status=$?
	return "$status"
}

test_install_and_copy() {
	new_case
	if ! run_setup --skip-update --yes; then
		fail_test "basic setup succeeds ($(cat "$err"))"
		return
	fi
	pass "basic setup succeeds"

	assert_contains "$log" "install $home/dev/FIT_pi" "installs FIT_pi by discovered path"
	assert_file "$home/.pi/agent/extensions/questionnaire.ts" "copies questionnaire extension"
	if cmp -s "$home/dev/sin/pi_questionare/questionnaire.ts" "$home/.pi/agent/extensions/questionnaire.ts"; then
		pass "questionnaire copy matches source"
	else
		fail_test "questionnaire copy matches source"
	fi
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
	assert_contains "$out" "install $home/dev/FIT_pi" "dry run prints planned FIT_pi install"
	if [ -s "$log" ]; then
		fail_test "dry run does not invoke pi"
	else
		pass "dry run does not invoke pi"
	fi
	assert_no_file "$home/.pi/agent/extensions/questionnaire.ts" "dry run does not copy files"
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
	assert_contains "$log" "install $home/dev/FIT_pi" "installs FIT_pi after updates"
}

test_idempotent_copy() {
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

	local backups
	backups=$(find "$home/.pi/agent/extensions" -name '*.bak-*' -print | wc -l | tr -d ' ')
	assert_equals "$backups" '0' "unchanged extension is not backed up"
}

test_backup_on_change() {
	new_case
	if ! run_setup --skip-update; then
		fail_test "backup test first run succeeds"
		return
	fi
	printf '\n// changed\n' >>"$home/dev/sin/pi_questionare/questionnaire.ts"
	if ! run_setup --skip-update; then
		fail_test "backup test second run succeeds"
		return
	fi
	local backups
	backups=$(find "$home/.pi/agent/extensions" -name '*.bak-*' -print | wc -l | tr -d ' ')
	assert_equals "$backups" '1' "changed extension gets one timestamped backup"
	assert_contains "$home/.pi/agent/extensions/questionnaire.ts" '// changed' "new extension content is installed"
}

test_package_switch() {
	new_case
	cat >"$home/dev/sin/pi_questionare/package.json" <<'EOF'
{
  "name": "pi-questionnaire",
  "pi": { "extensions": ["./questionnaire.ts"] }
}
EOF
	mkdir -p "$home/.pi/agent/extensions"
	printf 'old copy\n' >"$home/.pi/agent/extensions/questionnaire.ts"

	if ! run_setup --skip-update; then
		fail_test "package switch succeeds ($(cat "$err"))"
		return
	fi
	pass "package switch succeeds"
	assert_contains "$log" "install $home/dev/sin/pi_questionare" "installs questionnaire package"
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
	mkdir -p "$home/dev/other/FIT_pi"
	cp "$home/dev/FIT_pi/package.json" "$home/dev/other/FIT_pi/package.json"
	if run_setup --dry-run --skip-update; then
		fail_test "ambiguous discovery fails"
	else
		pass "ambiguous discovery fails"
	fi
	assert_contains "$err" 'found multiple FIT_pi package candidates' "ambiguous discovery explains the problem"
}

test_missing_discovery() {
	new_case
	rm -rf "$home/dev/FIT_pi"
	if run_setup --dry-run --skip-update; then
		fail_test "missing discovery fails"
	else
		pass "missing discovery fails"
	fi
	assert_contains "$err" 'could not find FIT_pi package' "missing discovery explains the problem"
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

test_install_and_copy
test_dry_run
test_update_order
test_idempotent_copy
test_backup_on_change
test_package_switch
test_failure_is_fatal
test_ambiguous_discovery
test_missing_discovery
test_env_override

if [ "$failures" -ne 0 ]; then
	printf '\n%s test(s) failed\n' "$failures" >&2
	exit 1
fi

printf '\nAll bash setup tests passed.\n'
