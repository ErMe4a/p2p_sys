class P2PMethod:
    def __init__(
            self,
            url,
            http_method,
            required_params
    ):
        self.url = url
        self.http_method = http_method
        self.required_params = required_params