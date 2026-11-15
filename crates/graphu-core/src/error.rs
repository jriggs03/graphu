use std::fmt;

/// What went wrong, in terms the server can turn into an HTTP status.
#[derive(Debug)]
pub enum Error {
    /// 404: the notebook, batch or proposal does not exist.
    NotFound(String),
    /// 409: the request conflicts with the current state (for example, a link whose concepts are not approved).
    Conflict(String),
    /// 422: the input is not acceptable.
    Invalid(String),
    Db(rusqlite::Error),
}

impl Error {
    pub fn status(&self) -> u16 {
        match self {
            Error::NotFound(_) => 404,
            Error::Conflict(_) => 409,
            Error::Invalid(_) => 422,
            Error::Db(_) => 500,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::NotFound(text) | Error::Conflict(text) | Error::Invalid(text) => f.write_str(text),
            Error::Db(error) => write!(f, "Storage error: {error}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self {
        Error::Db(error)
    }
}

pub type Result<T> = std::result::Result<T, Error>;
