.PHONY: dev-backend dev-frontend build run logs

dev-backend:
	cd backend && cargo watch -x run

dev-frontend:
	cd dashboard && npm run dev

build:
	docker build -f Dockerfile -t streamvault:dev .

run:
	docker compose up -d

logs:
	docker compose logs -f streamvault

stop:
	docker compose down

clean:
	docker compose down -v
