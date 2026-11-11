"""Typed errors carrying the pipeline stage where a failure happened."""


class StageError(Exception):
    """A pipeline failure bound to the stage that produced it."""

    def __init__(self, stage: str, message: str) -> None:
        super().__init__(message)
        self.stage = stage
        self.message = message
