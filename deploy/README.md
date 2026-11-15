# The live Graphu server

**https://graphu.3-12-190-201.sslip.io**

One AWS server in `us-east-2` runs the Docker image behind Caddy (HTTPS). Everything is tagged `graphu`.

| Thing | Value |
|---|---|
| Server | EC2 `i-025e0b6f8a7b76ed9`, `t4g.small` (2 vCPU, 2 GB, ARM), Ubuntu 24.04, 20 GB disk |
| Fixed address | `3.12.190.201` (Elastic IP `eipalloc-005f0fee98f56e9e2`) |
| Firewall | `sg-07fbd24dab1a301c9`: ports 80 and 443 open to all, port 22 only from the address that set it up |
| Login | `ssh -i ~/.ssh/graphu-key.pem ubuntu@3.12.190.201` (key pair `graphu-key`; the file is only on James's Mac) |
| Files on the server | `~/graphu/deploy/docker-compose.yml` and `.env` |
| Data | Docker volume `deploy_graphu-data` (the SQLite file). It survives restarts and new images. |

The site runs **without an Anthropic key**: the sample works, and uploads are recorded but not read.

## Ship a new version

From the repo on the Mac, with Docker running:

```sh
docker build -t graphu:local .
docker save graphu:local | gzip -1 | ssh -i ~/.ssh/graphu-key.pem ubuntu@3.12.190.201 'gunzip | sudo docker load'
ssh -i ~/.ssh/graphu-key.pem ubuntu@3.12.190.201 'cd ~/graphu/deploy && sudo docker compose up -d'
```

The image must be built on an ARM machine (an Apple Silicon Mac is one), because the server is ARM.

## Turn on reading uploads

With a key set, anyone with the link can spend it. Set a monthly limit in the Claude Console first. Then, from the repo on the Mac:

```sh
deploy/set-key.sh
```

It asks for the key at a hidden prompt, stores it on the server, and restarts Graphu. Run it again and press Enter with nothing typed to remove the key.

## Who sees what

There is no sign-in. On the first visit the site asks for a name and the browser makes up a random id. Each id has its own SQLite file in the `deploy_graphu-data` volume under `users/`, so people only see their own graphbooks. The id lives in that browser: another device or a cleared browser starts fresh. Graphbooks made before this change are still in the old shared file, `graphu.sqlite3`, in the same volume.

## If SSH stops working

Port 22 is open only to one IP address. From a different network, update the rule in the AWS console (EC2, Security Groups, `graphu-sg`, edit inbound rules, set the SSH source to "My IP").

## Stop paying for it

```sh
aws ec2 stop-instances --instance-ids i-025e0b6f8a7b76ed9      # pause: the disk and address still cost a little
```

To remove everything: terminate the instance, release the Elastic IP, then delete the security group and the key pair.
