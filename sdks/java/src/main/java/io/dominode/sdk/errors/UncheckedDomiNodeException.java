package io.dominode.sdk.errors;

/**
 * Unchecked wrapper for {@link DomiNodeException}.
 *
 * <p>Used internally when a checked DomiNodeException must be thrown across a
 * functional interface boundary (e.g., token refresh lambdas). Callers should
 * inspect {@link #getCause()} to retrieve the original typed exception.</p>
 *
 * <p>This preserves the exception type chain so that error-handling code can
 * distinguish authentication errors from network errors, unlike a bare
 * {@link RuntimeException} wrapper.</p>
 */
public class UncheckedDomiNodeException extends RuntimeException {

    /**
     * Wrap a DomiNodeException as an unchecked exception.
     *
     * @param cause the original checked exception
     */
    public UncheckedDomiNodeException(DomiNodeException cause) {
        super(cause.getMessage(), cause);
    }

    /**
     * Returns the original DomiNodeException.
     *
     * @return the wrapped DomiNodeException
     */
    @Override
    public DomiNodeException getCause() {
        return (DomiNodeException) super.getCause();
    }
}
