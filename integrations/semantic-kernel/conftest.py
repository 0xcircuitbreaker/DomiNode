"""Mock semantic_kernel module before any test imports."""
import sys
from unittest.mock import MagicMock

# Create mock semantic_kernel module hierarchy
sk_mock = MagicMock()
sk_functions_mock = MagicMock()


def _mock_kernel_function(name=None, description=None):
    """Mock @kernel_function decorator that sets the expected metadata attributes."""
    def decorator(func):
        func.__kernel_function__ = True
        func.__kernel_function_metadata__ = {
            "name": name,
            "description": description,
        }
        func._kernel_function = True
        return func
    return decorator


sk_functions_mock.kernel_function = _mock_kernel_function
sk_mock.functions = sk_functions_mock

sys.modules.setdefault("semantic_kernel", sk_mock)
sys.modules.setdefault("semantic_kernel.functions", sk_functions_mock)
