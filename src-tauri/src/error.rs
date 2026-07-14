use serde::Serialize;

/// All errors surfaced across the IPC boundary. Serialized to a plain string
/// so the frontend gets a readable message.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("git error: {0}")]
    Git(#[from] git2::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("{0}")]
    Msg(String),
}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
