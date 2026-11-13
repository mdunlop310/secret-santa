from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.routers import (
    draw,
    enter,
    exclusions,
    groups,
    internal,
    join,
    leave,
    links,
    me,
    unsubscribe,
)


def create_app() -> FastAPI:
    app = FastAPI(title="Secret Santa API")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=get_settings().cors_origin_list,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )
    app.include_router(groups.router)
    app.include_router(join.router)
    app.include_router(enter.router)
    app.include_router(links.router)
    app.include_router(me.router)
    app.include_router(exclusions.router)
    app.include_router(draw.router)
    app.include_router(leave.router)
    app.include_router(unsubscribe.router)
    app.include_router(internal.router)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
