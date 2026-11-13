#!/usr/bin/env bash
#
# Install/update Pi and the addons kept in this workspace.
#
# Usage: ./setup.sh [--dry-run] [--skip-update] [--verbose] [--yes]
#
set -euo pipefail

SCRIPT_NAME=$(basename "$0")
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DRY_RUN=0
SKIP_UPDATE=0
VERBOSE=0
ASSUME_YES=0
PI_BIN=""
FIT_PI_SRC=${FIT_PI_SRC:-}
QUESTIONNAIRE_SRC=${QUESTIONNAIRE_SRC:-}
GIT_COMMANDS_SRC=${GIT_COMMANDS_SRC:-}

usage() {
	cat <<EOF
$SCRIPT_NAME - set up Pi with the local addons

Usage:
  ./$SCRIPT_NAME [options]

Options:
  --dry-run       Show what would happen without changing anything
  --skip-update   Do not run "pi update" or "pi update --extensions"
  --verbose, -v   Show extra command detail
  --yes, -y       Non-interactive mode (accepted for convenience)
  --help, -h      Show this help

Environment:
  FIT_PI_SRC          Path to the FIT_pi package
  QUESTIONNAIRE_SRC   Path to the pi_questionare repository
  GIT_COMMANDS_SRC    Path to the pi-git-commands package

Without overrides, the script searches \$HOME, \$HOME/dev, then
\$HOME/dev/sin for directories named FIT_pi, pi_questionare, and
pi-git-commands. Ambiguous matches are an error.

If FIT_pi or pi-git-commands is missing, it is cloned into \$HOME/dev.
If pi_questionare is missing, the vendored copy in vendor/pi_questionare
is used. Local checkouts are reused as-is; they are not pulled.

The questionnaire and pi-git-commands repositories must be Pi packages
with manifests under their "pi" keys. They are installed with pi install.
An older bare extension copy in \$HOME/.pi/agent/extensions/ is backed up
and removed.
EOF
}

log() {
	printf '%s\n' "$*"
}

verbose() {
	if [ "$VERBOSE" -eq 1 ]; then
		printf '  %s\n' "$*"
	fi
}

die() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

parse_args() {
	while [ "$#" -gt 0 ]; do
		case "$1" in
		--dry-run)
			DRY_RUN=1
			;;
		--skip-update)
			SKIP_UPDATE=1
			;;
		--verbose | -v)
			VERBOSE=1
			;;
		--yes | -y)
			ASSUME_YES=1
			;;
		--help | -h)
			usage
			exit 0
			;;
		*)
			die "unknown option: $1 (try --help)"
			;;
		esac
		shift
	done
}

run() {
	if [ "$DRY_RUN" -eq 1 ]; then
		log "[dry-run] would run: $*"
		return 0
	fi
	verbose "running: $*"
	"$@"
}

canonical_dir() {
	(cd "$1" 2>/dev/null && pwd -P)
}

find_named_dirs() {
	local name="$1"
	local root
	for root in "$HOME" "$HOME/dev" "$HOME/dev/sin"; do
		[ -d "$root" ] || continue
		find "$root" -maxdepth 3 \
			\( -path "$SCRIPT_DIR/vendor" -o -name .git -o -name node_modules -o -name .pi -o -name .cache -o -name .local \) -prune -o \
			-type d -name "$name" -print 2>/dev/null || true
	done | while IFS= read -r candidate; do
		canonical_dir "$candidate"
	done | sort -u
}

is_questionnaire_package() {
	local dir="$1"
	[ -f "$dir/package.json" ] || return 1
	grep -Eq '"pi"[[:space:]]*:' "$dir/package.json"
}

validate_fit_pi() {
	local dir="$1"
	[ -f "$dir/package.json" ] || return 1
	grep -Eq '"name"[[:space:]]*:[[:space:]]*"pi-fit"' "$dir/package.json" ||
		grep -Eq '"pi"[[:space:]]*:' "$dir/package.json"
}

validate_questionnaire() {
	local dir="$1"
	is_questionnaire_package "$dir"
}

is_git_commands_package() {
	local dir="$1"
	[ -f "$dir/package.json" ] || return 1
	grep -Eq '"name"[[:space:]]*:[[:space:]]*"@svyaddict/pi-git-commands"' "$dir/package.json" &&
		grep -Eq '"pi"[[:space:]]*:' "$dir/package.json"
}

validate_git_commands() {
	local dir="$1"
	is_git_commands_package "$dir"
}

clone_missing_addon() {
	local label="$1"
	local dir_name="$2"
	local url="$3"
	local target="$HOME/dev/$dir_name"

	ADDON_FALLBACK_PATH="$target"

	if [ -d "$target" ]; then
		die "$label checkout already exists but is not valid: $target"
	fi

	if [ "$DRY_RUN" -eq 1 ]; then
		log "[dry-run] would clone $url -> $target"
		return 0
	fi

	command -v git >/dev/null 2>&1 || die "need git to clone $label from $url"
	log "Cloning $label from $url..."
	mkdir -p "$(dirname "$target")"
	git clone "$url" "$target" || die "failed to clone $label from $url"
}

discover_addon() {
	local label="$1"
	local env_name="$2"
	local dir_name="$3"
	local override="$4"
	local validator="$5"
	local fallback_kind="${6:-}"
	local fallback_value="${7:-}"
	local candidates
	local count
	local chosen

	if [ -n "$override" ]; then
		[ -d "$override" ] || die "$env_name is not a directory: $override"
		chosen=$(canonical_dir "$override") || die "cannot resolve $env_name: $override"
		"$validator" "$chosen" || die "$env_name does not look like $label: $override"
		ADDON_PATH="$chosen"
		return 0
	fi

	candidates=$(find_named_dirs "$dir_name")
	count=0
	if [ -n "$candidates" ]; then
		count=$(printf '%s\n' "$candidates" | grep -c .)
	fi

	if [ "$count" -eq 0 ]; then
		case "$fallback_kind" in
		clone)
			clone_missing_addon "$label" "$dir_name" "$fallback_value"
			chosen="$ADDON_FALLBACK_PATH"
			if [ -d "$chosen" ]; then
				"$validator" "$chosen" || die "cloned $label but it does not look valid: $chosen"
			fi
			ADDON_PATH="$chosen"
			return 0
			;;
		vendor)
			chosen=$(canonical_dir "$fallback_value") || die "could not find $label and the vendored copy is missing: $fallback_value"
			"$validator" "$chosen" || die "vendored $label does not look valid: $chosen"
			ADDON_PATH="$chosen"
			return 0
			;;
		*)
			die "could not find $label. Set $env_name to its directory."
			;;
		esac
	fi

	if [ "$count" -gt 1 ]; then
		printf 'error: found multiple %s candidates:\n' "$label" >&2
		printf '%s\n' "$candidates" | while IFS= read -r candidate; do
			printf '  %s\n' "$candidate" >&2
		done
		die "set $env_name to choose one"
	fi

	chosen=$(printf '%s\n' "$candidates" | sed -n '1p')
	"$validator" "$chosen" || die "found $label but it does not look valid: $chosen"
	ADDON_PATH="$chosen"
}

resolve_pi() {
	local candidate
	if command -v pi >/dev/null 2>&1; then
		command -v pi
		return 0
	fi
	for candidate in \
		"$HOME/.pi/agent/bin/pi" \
		"$HOME/.pi/agent/bin/pi.exe" \
		"$HOME/.pi/agent/bin/pi.cmd" \
		"$HOME/.pi/agent/bin/pi.ps1"; do
		if [ -f "$candidate" ]; then
			printf '%s\n' "$candidate"
			return 0
		fi
	done
	return 1
}

install_pi() {
	if [ "$DRY_RUN" -eq 1 ]; then
		log "[dry-run] would install Pi from https://pi.dev/install.sh"
		return 0
	fi

	if command -v curl >/dev/null 2>&1; then
		verbose "installing Pi with curl"
		curl -fsSL https://pi.dev/install.sh | sh
	elif command -v wget >/dev/null 2>&1; then
		verbose "installing Pi with wget"
		wget -qO- https://pi.dev/install.sh | sh
	else
		die "need curl or wget to install Pi"
	fi
}

backup_file() {
	local target="$1"
	local stamp
	local backup
	local n

	[ -e "$target" ] || return 0

	stamp=$(date +%Y%m%d-%H%M%S)
	backup="${target}.bak-${stamp}"
	n=1
	while [ -e "$backup" ]; do
		backup="${target}.bak-${stamp}-${n}"
		n=$((n + 1))
	done

	if [ "$DRY_RUN" -eq 1 ]; then
		log "[dry-run] would back up $target -> $backup"
		return 0
	fi

	cp -p "$target" "$backup"
	verbose "backed up $target -> $backup"
}

main() {
	local old_extension
	local pi_install_cmd

	parse_args "$@"

	discover_addon "FIT_pi package" "FIT_PI_SRC" "FIT_pi" "$FIT_PI_SRC" validate_fit_pi clone "git@github.com:Zaphodious/FIT_pi.git"
	FIT_PI_SRC="$ADDON_PATH"
	discover_addon "pi_questionare package" "QUESTIONNAIRE_SRC" "pi_questionare" "$QUESTIONNAIRE_SRC" validate_questionnaire vendor "$SCRIPT_DIR/vendor/pi_questionare"
	QUESTIONNAIRE_SRC="$ADDON_PATH"
	discover_addon "pi-git-commands package" "GIT_COMMANDS_SRC" "pi-git-commands" "$GIT_COMMANDS_SRC" validate_git_commands clone "https://github.com/svyaddict/pi-git-commands.git"
	GIT_COMMANDS_SRC="$ADDON_PATH"

	log "FIT_pi: $FIT_PI_SRC"
	log "Questionnaire: $QUESTIONNAIRE_SRC"
	log "pi-git-commands: $GIT_COMMANDS_SRC"

	PI_BIN=$(resolve_pi || true)
	if [ -z "$PI_BIN" ]; then
		if [ "$DRY_RUN" -eq 1 ]; then
			log "[dry-run] Pi is not installed; would install it"
		else
			log "Pi not found; installing..."
			install_pi
			PI_BIN=$(resolve_pi || true)
			[ -n "$PI_BIN" ] || die "Pi installation finished but pi was not found"
		fi
	else
		log "Pi: $PI_BIN"
	fi

	if [ "$SKIP_UPDATE" -eq 0 ]; then
		if [ -n "$PI_BIN" ]; then
			log "Updating Pi..."
			run "$PI_BIN" update
			log "Updating Pi packages..."
			run "$PI_BIN" update --extensions
		else
			log "[dry-run] would run: pi update"
			log "[dry-run] would run: pi update --extensions"
		fi
	else
		log "Skipping Pi update (--skip-update)"
	fi

	log "Installing FIT_pi package..."
	if [ -n "$PI_BIN" ]; then
		run "$PI_BIN" install "$FIT_PI_SRC"
	else
		log "[dry-run] would run: pi install \"$FIT_PI_SRC\""
	fi

	log "Installing questionnaire package..."
	if [ -n "$PI_BIN" ]; then
		run "$PI_BIN" install "$QUESTIONNAIRE_SRC"
	else
		log "[dry-run] would run: pi install \"$QUESTIONNAIRE_SRC\""
	fi

	log "Installing pi-git-commands package..."
	if [ -n "$PI_BIN" ]; then
		run "$PI_BIN" install "$GIT_COMMANDS_SRC"
	else
		log "[dry-run] would run: pi install \"$GIT_COMMANDS_SRC\""
	fi

	old_extension="$HOME/.pi/agent/extensions/questionnaire.ts"
	if [ -e "$old_extension" ]; then
		log "Removing old questionnaire extension copy to avoid duplicate registration..."
		backup_file "$old_extension"
		if [ "$DRY_RUN" -eq 1 ]; then
			log "[dry-run] would remove $old_extension"
		else
			rm -f "$old_extension"
			verbose "removed $old_extension"
		fi
	fi

	pi_install_cmd="$PI_BIN"
	if [ -z "$pi_install_cmd" ]; then
		pi_install_cmd="pi"
	fi
	log "Pi setup complete. Run: $pi_install_cmd"
}

main "$@"
