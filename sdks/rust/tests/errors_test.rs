use dominusnode::DominusNodeError;

#[test]
fn test_authentication_error_display() {
    let err = DominusNodeError::Authentication("Invalid credentials".to_string());
    assert_eq!(
        format!("{}", err),
        "Authentication failed: Invalid credentials"
    );
}

#[test]
fn test_authorization_error_display() {
    let err = DominusNodeError::Authorization("Admin only".to_string());
    assert_eq!(format!("{}", err), "Authorization denied: Admin only");
}

#[test]
fn test_rate_limit_error_display() {
    let err = DominusNodeError::RateLimit {
        message: "Too many requests".to_string(),
        retry_after_seconds: 30,
    };
    assert_eq!(
        format!("{}", err),
        "Rate limited: retry after 30s - Too many requests"
    );
}

#[test]
fn test_insufficient_balance_error_display() {
    let err = DominusNodeError::InsufficientBalance("Need at least 100 cents".to_string());
    assert_eq!(
        format!("{}", err),
        "Insufficient balance: Need at least 100 cents"
    );
}

#[test]
fn test_validation_error_display() {
    let err = DominusNodeError::Validation("Email is required".to_string());
    assert_eq!(format!("{}", err), "Validation error: Email is required");
}

#[test]
fn test_not_found_error_display() {
    let err = DominusNodeError::NotFound("User not found".to_string());
    assert_eq!(format!("{}", err), "Not found: User not found");
}

#[test]
fn test_conflict_error_display() {
    let err = DominusNodeError::Conflict("Email already exists".to_string());
    assert_eq!(format!("{}", err), "Conflict: Email already exists");
}

#[test]
fn test_server_error_display() {
    let err = DominusNodeError::Server("Internal server error".to_string());
    assert_eq!(format!("{}", err), "Server error: Internal server error");
}

#[test]
fn test_proxy_error_display() {
    let err = DominusNodeError::Proxy {
        message: "Connection refused".to_string(),
        error_code: Some("ECONNREFUSED".to_string()),
    };
    assert_eq!(format!("{}", err), "Proxy error: Connection refused");
}

#[test]
fn test_proxy_error_without_code() {
    let err = DominusNodeError::Proxy {
        message: "Timeout".to_string(),
        error_code: None,
    };
    assert_eq!(format!("{}", err), "Proxy error: Timeout");
}

#[test]
fn test_error_is_debug() {
    let err = DominusNodeError::Authentication("test".to_string());
    // Debug trait should be implemented.
    let debug_str = format!("{:?}", err);
    assert!(debug_str.contains("Authentication"));
    assert!(debug_str.contains("test"));
}

#[test]
fn test_json_error_display() {
    let json_err = serde_json::from_str::<serde_json::Value>("invalid json").unwrap_err();
    let err = DominusNodeError::Json(json_err);
    let display = format!("{}", err);
    assert!(display.starts_with("JSON error:"));
}
