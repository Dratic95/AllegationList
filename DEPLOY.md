# Hosting the bot 24/7 on Oracle Cloud (free)

This puts the bot on a free Oracle Cloud server that never turns off. Once it's set up, the bot
starts by itself when the server boots and restarts itself if it ever crashes. Your PC can be
off.

You do the Oracle steps (they need your own account). The project's scripts do everything else.
Plan on about 30–45 minutes the first time.

---

## Part 1 — Create the Oracle Cloud account

1. Go to **https://www.oracle.com/cloud/free/** and click **Start for free**.
2. Sign up. Oracle asks for a card **only to verify you're a real person**; Always Free
   resources are never charged.
3. Pick a **home region** close to you (it can't be changed later). If one region says it's
   out of free capacity when you create the server in Part 2, that's a known Oracle quirk;
   trying again later usually works.
4. Wait for the "account is ready" email, then sign in to the Oracle Cloud Console.

### Upgrade to Pay As You Go (important)

Oracle **stops idle Always Free servers**: if CPU, network and memory all stay under 20% for
7 days, which a Discord bot easily does. Upgrading the account to **Pay As You Go** stops
that, and Always Free resources stay free.

1. In the Console, open the menu (☰) → **Billing & Cost Management** → **Upgrade and Manage
   Payment**. (Oracle renames menus now and then; searching the Console for "upgrade" finds
   it too.)
2. Choose **Pay As You Go** and confirm. (Oracle may place and then release a small
   temporary charge to check the card.)
3. Only ever create resources marked **Always Free eligible**, and nothing will be billed.
   Optional but recommended: **Billing → Budgets → Create Budget** with a $1 alert, so
   you'd get an email if anything ever did cost money.

---

## Part 2 — Create the server

1. Console menu (☰) → **Compute** → **Instances** → **Create instance**.
2. **Name:** `allegation-bot`.
3. **Image and shape** → **Edit**:
   - **Image:** click **Change image** → **Ubuntu** → **Canonical Ubuntu 24.04**.
   - **Shape:** click **Change shape**. Either of these is Always Free and is plenty:
     - **Ampere → VM.Standard.A1.Flex** with **1 OCPU and 6 GB memory**, or
     - **AMD → VM.Standard.E2.1.Micro** (use this if A1 says it's out of capacity).
4. **Networking:** leave the defaults (a new virtual cloud network with a public subnet).
   Make sure **Assign a public IPv4 address** is on.
5. **Add SSH keys:** choose **Generate a key pair for me**, then click
   **Save private key**. Move the downloaded file to `%USERPROFILE%\.ssh\` and rename it
   `oracle-bot.key` (create the `.ssh` folder if it doesn't exist). **Keep this file safe;
   it's the only way into the server.**
6. Click **Create**. When the instance shows **Running**, copy its **Public IP address**
   from the instance page.

### Lock down the key file (Windows refuses keys other users can read)

Open **Command Prompt** (not PowerShell) and run these three lines:

```
icacls "%USERPROFILE%\.ssh\oracle-bot.key" /inheritance:r
icacls "%USERPROFILE%\.ssh\oracle-bot.key" /grant:r "%USERNAME%:R"
icacls "%USERPROFILE%\.ssh\oracle-bot.key"
```

The last line should list only your own user.

### Check you can log in

```
ssh -i "%USERPROFILE%\.ssh\oracle-bot.key" ubuntu@<PUBLIC IP>
```

Type `yes` if asked about the fingerprint. You should get an `ubuntu@allegation-bot` prompt.
Type `exit` to leave. (If it times out, wait two minutes; new servers take a moment to boot.)

---

## Part 3 — Put the bot on the server

1. **Make sure the bot isn't running on your PC** (two copies answer every command twice).
2. Open **Command Prompt** in the project folder:

   ```
   cd %USERPROFILE%\Documents\AllegationList
   ```

3. Run the deploy script with your server's IP:

   ```
   deploy\deploy.cmd ubuntu@<PUBLIC IP> "%USERPROFILE%\.ssh\oracle-bot.key"
   ```

It packs the project (including `.env` and your current `data.json`, so numbering and
settings carry over), uploads it, installs Node.js, and starts the bot as a service. The first
run takes a few minutes. It ends by showing the bot's latest log lines, which should include
**Logged in as AllegationList#4803**.

That's it: the bot now runs on the server around the clock.

---

## Day-to-day

**Update the bot after a code change** — run the same command again:

```
deploy\deploy.cmd ubuntu@<PUBLIC IP> "%USERPROFILE%\.ssh\oracle-bot.key"
```

Updates never overwrite the server's `data.json` (it's the live copy now), and each update
first saves a backup of it on the server (`data.json.bak-<date>`, newest 5 kept).

**Check on it** — log in with `ssh` (as in Part 2), then:

| What | Command |
|---|---|
| Is it running? | `sudo systemctl status allegationlist` |
| Live logs (Ctrl+C to stop watching) | `sudo journalctl -u allegationlist -f` |
| Restart it | `sudo systemctl restart allegationlist` |
| Stop it | `sudo systemctl stop allegationlist` |
| Start it again | `sudo systemctl start allegationlist` |
| Keep it from starting at boot | `sudo systemctl disable --now allegationlist` |

**Change the profile picture or About Me** — run those from your PC as before
(`node --env-file=.env set-avatar.js`); they talk to Discord directly and don't need the
server.

**Change the bot token** — update `.env` on your PC, then run the deploy command again.

**Keep the server patched** — every month or so, log in and run:

```
sudo apt update && sudo apt upgrade -y && sudo reboot
```

The bot comes back by itself after the reboot.

---

## Where things are on the server

| Path | What |
|---|---|
| `/opt/allegationlist/` | The bot (owned by the `allegationlist` user, private to it) |
| `/opt/allegationlist/data.json` | The live data: allegation list, settings, review queue |
| `/opt/allegationlist/data.json.bak-*` | Automatic backups from each update |
| `/opt/allegationlist/.env` | The token (readable only by the service user) |
| `/etc/systemd/system/allegationlist.service` | The service definition |

To copy the live data back to your PC (for a backup): the bot's folder is private, so first
make a copy you can read. On the server:

```
sudo cp /opt/allegationlist/data.json ~/data.json && sudo chown ubuntu:ubuntu ~/data.json
```

Then, from Command Prompt on your PC:

```
scp -i "%USERPROFILE%\.ssh\oracle-bot.key" ubuntu@<PUBLIC IP>:data.json data.server-backup.json
```

And finally remove the copy on the server with `rm ~/data.json`.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `UNPROTECTED PRIVATE KEY FILE` / `bad permissions` | Run the three `icacls` lines in Part 2. |
| `Connection timed out` | Check the IP, and that the instance is **Running**. The default network allows SSH; if you changed it, port 22 must be open. |
| `Permission denied (publickey)` | Use the user `ubuntu` and the key you downloaded when creating the instance. |
| `Out of host capacity` when creating the instance | Try the other Always Free shape, or try again later. |
| Every command answered twice | The bot is also running on your PC. Stop that copy. |
| Deploy ends with "The bot did NOT stay running" | Read the log lines it printed. The usual cause is a wrong token in `.env`. |
| Oracle emailed about an idle instance | Upgrade to Pay As You Go (Part 1), then start the instance again from the Console. |
| The server was rebooted | Nothing to do: the service starts at boot. |
