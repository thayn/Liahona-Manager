# Putting the Liahona Manager in the cloud (one-time setup)

About 20 minutes, mostly waiting. After this, every push to `main` updates the site automatically.

You need: your AWS account (signed in as an administrator) and this GitHub repo.

## 1. Let GitHub deploy to your AWS account

This creates a role that only this repo's `main` branch can use. No AWS keys are stored in GitHub.

1. Sign in to the AWS console. In the top right, set the region to **US West (Oregon) us-west-2**.
2. Open **CloudFormation**, then **Create stack** and **With new resources**.
3. Choose **Upload a template file** and pick `infra/github-deploy-role.yaml` from this repo (download it from GitHub first). Click **Next**.
4. Stack name: `liahona-github-deploy`. Leave the parameters as they are.
   - Set **CreateGitHubConnection** to **no** only if you've connected GitHub Actions to this AWS account before. If you're not sure, leave it on **yes**. If creating the stack then fails with "already exists", delete the failed stack and try again with **no**.
5. Click **Next** twice. Tick **I acknowledge that AWS CloudFormation might create IAM resources**, then **Submit**.
6. When the status says **CREATE_COMPLETE** (about a minute), open the **Outputs** tab and copy **RoleArn**. It looks like `arn:aws:iam::123456789012:role/liahona-manager-github-deploy`.

## 2. Tell GitHub about it

In GitHub, open the **Liahona-Manager** repo, then **Settings → Secrets and variables → Actions**, and the **Variables** tab. Add two **repository variables**:

| Name | Value |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | the RoleArn from step 1 |
| `ADMIN_EMAIL` | your email. You become the first Admin. |

`AWS_REGION` is optional. Leave it out to use us-west-2.

## 3. Deploy

Open the **Actions** tab, choose **Deploy to AWS**, then **Run workflow**. The first run takes about 10–15 minutes. Setting up the site's worldwide address (CloudFront) is the slow part.

When it's green, open the run. The summary shows:
- **Manager:** `https://d1234abcd.cloudfront.net`. Bookmark this.
- **Sign-up form:** the same address with `/register` on the end.

## 4. Sign in

You'll get an email, **Your Liahona Manager account**, with a temporary password. Open the Manager address, sign in, and choose your own password.

Then, in the Manager:
1. **Settings → Event:** name, dates and first day. Keep **Sign-up form is open** off until you're ready.
2. **Users:** invite the other leaders and pick their roles. Each gets their own email.
3. **Leaders:** put each leader's email on their **People** entry, so they see their own team.

## 5. Move what's on the laptop into the cloud (once)

1. In the cloud Manager, open **Settings → Camp laptop**, then **Create key**. Copy the key and the cloud address.
2. On the laptop, start the Manager as usual. Open **Settings → Cloud**, paste both, and click **Save**.
3. Open **First-time setup**, then **Copy this laptop to the cloud**. People, teams, cards, places, Journeys and media all go up.

From then on, the **cloud is the main copy**. Keep the laptop for camp.

## At camp

- **Before you leave** (with internet): on the laptop, **Settings → Cloud → Download for camp**. The laptop gets everything, including media, and the cloud turns read-only.
- **At camp:** everything is edited on the laptop, with no internet needed. Phones and iPads on the laptop's Wi-Fi sign in with their email and a **sign-in code**. Set the codes in **Settings → Sign-in codes** on the laptop.
- **After camp** (back on internet): **Settings → Cloud → Upload after camp**. Any sign-ups that came in during camp are kept.
- **If the laptop is lost or broken:** an Admin can click **Unlock without the laptop** in the cloud. Changes made at camp are lost.

## Costs

With camp-sized use, expect well under $1 a month. CloudFront, Lambda, API Gateway, S3 and Cognito all charge by use, and the free tiers cover most of it. Video media is the only real storage cost, at about 2.3¢ per GB a month.

To be safe, set a budget alert: **Billing → Budgets → Create budget → Monthly cost budget**, $5, with an email alert.

## Where things are

| What | Where in AWS (us-west-2) |
|---|---|
| Everything | CloudFormation stack **LiahonaManager** |
| The data (every version kept for 400 days) | S3 bucket `liahonamanager-data…`, file `workspace.json` |
| Journey media | S3 bucket `liahonamanager-media…` |
| Accounts | Cognito user pool `liahona-manager` |
| Error logs | CloudWatch Logs, `LiahonaManager-ApiLogs…` |

**Restoring an older copy:** in the data bucket, select `workspace.json`, turn on **Show versions**, and download the version you want. Ask Claude to help put it back.

The data and media buckets and the user pool are kept even if the stack is deleted, so camp data is never lost by accident.
