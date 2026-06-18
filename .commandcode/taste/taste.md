# Taste (Continuously Learned by [CommandCode][cmd])

[cmd]: https://commandcode.ai/

# pipeline
- Use transmission-daemon + transmission-cli for torrent download functionality (not librqbit/aria2c). On Ubuntu, transmission-cli is just the daemon controller — requires transmission-daemon running alongside it. Stop systemd daemon first then run foreground with --no-global-seed. Confidence: 0.75

