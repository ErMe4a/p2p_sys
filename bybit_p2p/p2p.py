from .p2p_requests import P2PRequests


class P2P(
    P2PRequests
):
    def __init__(self, **args):
        super().__init__(**args)