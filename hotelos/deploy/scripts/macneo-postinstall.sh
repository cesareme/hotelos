#!/usr/bin/env bash
# HotelOS · MacBook Neo post-Brewfile setup
#
# Run AFTER `brew bundle --file=macneo-Brewfile` finished.
# Idempotent — re-run to refresh dotfiles after a brew upgrade.

set -euo pipefail

log() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }

ZSHRC="$HOME/.zshrc"

log "1/8 · Starship prompt config"
mkdir -p "$HOME/.config"
cat > "$HOME/.config/starship.toml" <<'TOML'
# Starship config — minimal, fast, informative.
# https://starship.rs/config/
add_newline = true

format = """
$os\
$username\
[ ](fg:#33658A bg:#86BBD8)\
$directory\
[ ](fg:#86BBD8 bg:#F6AE2D)\
$git_branch\
$git_status\
[ ](fg:#F6AE2D bg:#F26419)\
$nodejs\
$python\
$rust\
$package\
[ ](fg:#F26419 bg:#86BBD8)\
$time\
[ ](fg:#86BBD8)\
$cmd_duration\
$line_break\
$character"""

[directory]
truncation_length = 3
style = "bg:#86BBD8 fg:#1d2230 bold"
format = "[ $path ]($style)"

[git_branch]
symbol = " "
style = "bg:#F6AE2D fg:#1d2230"
format = '[ $symbol$branch ]($style)'

[git_status]
style = "bg:#F6AE2D fg:#1d2230"
format = '[$all_status$ahead_behind ]($style)'

[nodejs]
symbol = " "
style = "bg:#F26419 fg:#1d2230"
format = '[ $symbol$version ]($style)'

[time]
disabled = false
time_format = "%R"
style = "bg:#86BBD8 fg:#1d2230"
format = '[ ♥ $time ]($style)'

[cmd_duration]
min_time = 1000
format = "  took [$duration](bold yellow)"

[character]
success_symbol = "[➜](bold green) "
error_symbol = "[➜](bold red) "
TOML

log "2/8 · Patch ~/.zshrc with modern tooling (idempotent)"
touch "$ZSHRC"

ensure_line() {
    local line="$1"
    grep -qxF "$line" "$ZSHRC" || echo "$line" >> "$ZSHRC"
}

# Brew shellenv (handles ARM vs Intel paths automatically).
ensure_line 'eval "$(/opt/homebrew/bin/brew shellenv)"'

# Starship prompt.
ensure_line 'eval "$(starship init zsh)"'

# zoxide — z <substring> jumps to most-used matching directory.
ensure_line 'eval "$(zoxide init zsh)"'

# mise — Node/Python/Go version manager (per-project shims).
ensure_line 'eval "$(mise activate zsh)"'

# fzf keybindings (Ctrl+R reverse history, Ctrl+T file picker, Alt+C cd).
ensure_line 'source <(fzf --zsh) 2>/dev/null || true'

# direnv — auto-loads .envrc when you cd into a project.
ensure_line 'eval "$(direnv hook zsh)"'

# 1Password CLI — bind SSH key signing + git signing via 1Password agent.
ensure_line 'export SSH_AUTH_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"'

# Modern aliases — `ls` → eza, `cat` → bat, `find` → fd.
ensure_line "alias ls='eza --icons --git'"
ensure_line "alias ll='eza --icons --git -la --group-directories-first'"
ensure_line "alias tree='eza --tree --git-ignore --level=3'"
ensure_line "alias cat='bat --paging=never --style=plain'"
ensure_line "alias find='fd'"
ensure_line "alias grep='rg'"
ensure_line "alias lg='lazygit'"
ensure_line "alias k='kubectl' # if/when you go k8s"

# HotelOS shortcuts.
ensure_line "alias hotelos='ssh hotelos-dev'"
ensure_line "alias dev='ssh hotelos-dev -t \"cd ~/projects/hotelos && tmux new -A -s dev\"'"

log "3/8 · fzf shell integration"
yes | "$(brew --prefix)/opt/fzf/install" --key-bindings --completion --no-update-rc 2>/dev/null || true

log "4/8 · mise global runtimes (Node 22, Python 3.13, Go 1.23)"
mise use --global node@22 python@3.13 go@1.23 || true
mise install || true

log "5/8 · Install global npm tools (only what's worth installing globally)"
npm install -g \
    @anthropic-ai/claude-code \
    npm-check-updates \
    serve \
    pnpm 2>/dev/null || true

log "6/8 · Set Ghostty as default terminal (manual: System Settings → Default)"
# Apple doesn't expose this via CLI for third-party terminals; user does it from
# System Settings → "Default web browser/terminal" once.
echo "Open Ghostty once, then System Settings to make it your default."

log "7/8 · Default git config for new repos"
git config --global init.defaultBranch main
git config --global push.autoSetupRemote true
git config --global pull.rebase true
git config --global rerere.enabled true
git config --global core.pager "delta"
git config --global interactive.diffFilter "delta --color-only"
git config --global delta.navigate true
git config --global delta.light false
git config --global merge.conflictStyle diff3
git config --global diff.colorMoved default

log "8/8 · Done. Restart your shell or run: source ~/.zshrc"

cat <<'NEXT'

🎉  MacBook Neo developer powerhouse setup complete.

What to try first:
  • Press Cmd+Space → Raycast (replace the muscle memory)
  • Type "Cmd+Shift+V" → Maccy clipboard history
  • In a folder, type `lg` → lazygit
  • Type `z hotel<Tab>` → zoxide jumps to your project even from /tmp
  • Hit `Ctrl+R` in shell → fzf fuzzy history
  • In Ghostty `Cmd+T` for tabs, `Cmd+D` for split panes

Manual setup remaining:
  • Open Ghostty → System Settings → set as default terminal
  • Open Raycast → finish onboarding (3 min)
  • Open 1Password → enable SSH agent (Settings → Developer → SSH agent)
  • Open Tailscale → sign in with the same account on your VPS too
  • Open Cursor / VS Code → Cmd+Shift+P → "Remote-SSH: Connect to Host"
  • Sign into Claude Desktop → your past conversations are right there
NEXT
