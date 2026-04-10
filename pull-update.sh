#!/bin/bash

echo "=== Git Pull dengan Backup Config ==="
echo ""

# Backup config.json yang ada
if [ -f "config.json" ]; then
    echo "📦 Backing up config.json..."
    cp config.json config.json.backup
    echo "✅ Backup saved to config.json.backup"
fi

# Backup .gitignore yang ada
if [ -f ".gitignore" ]; then
    echo "📦 Backing up .gitignore..."
    cp .gitignore .gitignore.backup
    echo "✅ Backup saved to .gitignore.backup"
fi

echo ""
echo "🔄 Stashing local changes..."
git stash

echo ""
echo "⬇️  Pulling from GitHub..."
git pull origin main

echo ""
echo "📝 Restoring your config..."

# Restore config.json jika ada backup
if [ -f "config.json.backup" ]; then
    # Ambil telegram config dari backup
    echo "Merging your Telegram config..."
    
    # Jika Anda punya jq (JSON processor), bisa merge otomatis
    # Jika tidak, restore manual
    mv config.json.backup config.json
    echo "✅ Your config.json restored"
    echo "⚠️  Note: Please manually merge telegram settings if needed"
fi

echo ""
echo "✅ Pull complete!"
echo ""
echo "Next steps:"
echo "1. Check config.json - make sure telegram settings are correct"
echo "2. Run: npm install (to install new dependencies)"
echo "3. Run: npm run monitor (to start monitoring)"
