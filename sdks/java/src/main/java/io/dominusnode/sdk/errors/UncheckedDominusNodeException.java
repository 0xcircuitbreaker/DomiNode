package io.dominusnode.sdk.errors;

/**
 * Unchecked wrapper for {@link DominusNodeException}.
 *
 * <p>Used internally when a checked DominusNodeException must be thrown across a
 * functional interface boundary (e.g., token refresh lambdas). Callers should
 * inspect {@link #getCause()} to retrieve the original typed exception.</p>
 *
 * <p>This preserves the exception type chain so that error-handling code can
 * distinguish authentication errors from network errors, unlike a bare
 * {@link RuntimeException} wrapper.</p>
 */
public class UncheckedDominusNodeException extends RuntimeException {

    /**
     * Wrap a DominusNodeException as an unchecked exception.
     *
     * @param cause the original checked exception
     */
    public UncheckedDominusNodeException(DominusNodeException cause) {
        super(cause.getMessage(), cause);
    }

    /**
     * Returns the original DominusNodeException.
     *
     * @return the wrapped DominusNodeException
     */
    @Override
    public DominusNodeException getCause() {
        return (DominusNodeException) super.getCause();
    }
}
