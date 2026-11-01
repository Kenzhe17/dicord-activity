# 🔒 Security Information

## Important: Do NOT commit secrets

### Discord Client Secret
Your Discord Client Secret (`U_HwtYGzvfUxQr-aRLWekHmRCJRQxocD`) is a SECRET.

⚠️ **NEVER commit this to GitHub!**
⚠️ **NEVER add it to .env files that are tracked by git!**
⚠️ **NEVER share it publicly!**

### Where to add Client Secret

**Railway (Production):**
- Add as environment variable: `DISCORD_CLIENT_SECRET=U_HwtYGzvfUxQr-aRLWekHmRCJRQxocD`
- This is the ONLY place where it should be stored

**Local Development (Optional):**
- Create `.env` file (already in .gitignore)
- Add: `DISCORD_CLIENT_SECRET=U_HwtYGzvfUxQr-aRLWekHmRCJRQxocD`
- `.env` is NOT committed to git

### What IS safe to commit

✅ Client ID: `1566376251185168394` (public)
✅ Application URLs
✅ Configuration templates (.env.example)

### What is NOT safe to commit

❌ Client Secret: `U_HwtYGzvfUxQr-aRLWekHmRCJRQxocD`
❌ Bot tokens
❌ API keys
❌ Any `.env` files with real secrets

### Verification

Before pushing to GitHub, verify:
```bash
git diff
```

Make sure no secrets are in the diff!

### If you accidentally committed a secret

1. Remove the secret from the file
2. Commit the fix
3. If already pushed, rotate the secret in Discord Developer Portal
4. Consider using git-filter-repo to remove from history
