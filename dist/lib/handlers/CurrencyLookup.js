import { NATIVE_NAMES_BY_ID, nativeOnChain } from '@uniswap/smart-order-router';
import { isAddress } from '../util/isAddress';
/**
 * CurrencyLookup searches native tokens, token lists, and on chain to determine
 * the token details (called Currency by the sdk) for an inputted string.
 */
export class CurrencyLookup {
    constructor(tokenListProvider, tokenProvider, log) {
        this.tokenListProvider = tokenListProvider;
        this.tokenProvider = tokenProvider;
        this.log = log;
        this.checkIfNativeToken = (tokenRaw, chainId) => {
            if (!NATIVE_NAMES_BY_ID[chainId] || !NATIVE_NAMES_BY_ID[chainId].includes(tokenRaw)) {
                return undefined;
            }
            const nativeToken = nativeOnChain(chainId);
            this.log.debug({
                tokenAddress: nativeToken.wrapped.address,
            }, `Found native token ${tokenRaw} for chain ${chainId}: ${nativeToken.wrapped.address}}`);
            return nativeToken;
        };
        this.checkTokenLists = async (tokenRaw) => {
            let token = undefined;
            if (isAddress(tokenRaw)) {
                token = await this.tokenListProvider.getTokenByAddress(tokenRaw);
            }
            if (!token) {
                token = await this.tokenListProvider.getTokenBySymbol(tokenRaw);
            }
            if (token) {
                this.log.debug({
                    tokenAddress: token.wrapped.address,
                }, `Found token ${tokenRaw} in token lists.`);
            }
            return token;
        };
        this.checkOnChain = async (tokenRaw) => {
            this.log.debug(`Getting input token ${tokenRaw} from chain`);
            // The ITokenListProvider interface expects a list of addresses to lookup tokens.
            // If this isn't an address, we can't do the lookup.
            // https://github.com/Uniswap/smart-order-router/blob/71fac1905a32af369e30e9cbb52ea36e971ab279/src/providers/token-provider.ts#L23
            if (!isAddress(tokenRaw)) {
                return undefined;
            }
            const tokenAccessor = await this.tokenProvider.getTokens([tokenRaw]);
            return tokenAccessor.getTokenByAddress(tokenRaw);
        };
    }
    async searchForToken(tokenRaw, chainId) {
        const nativeToken = this.checkIfNativeToken(tokenRaw, chainId);
        if (nativeToken) {
            return nativeToken;
        }
        // At this point, we know this is not a NativeCurrency based on the check above, so we can explicitly cast to Token.
        const tokenFromTokenList = await this.checkTokenLists(tokenRaw);
        if (tokenFromTokenList) {
            return tokenFromTokenList;
        }
        return await this.checkOnChain(tokenRaw);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiQ3VycmVuY3lMb29rdXAuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9saWIvaGFuZGxlcnMvQ3VycmVuY3lMb29rdXAudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQ0EsT0FBTyxFQUFzQyxrQkFBa0IsRUFBRSxhQUFhLEVBQUUsTUFBTSw2QkFBNkIsQ0FBQTtBQUVuSCxPQUFPLEVBQUUsU0FBUyxFQUFFLE1BQU0sbUJBQW1CLENBQUE7QUFFN0M7OztHQUdHO0FBQ0gsTUFBTSxPQUFPLGNBQWM7SUFDekIsWUFDbUIsaUJBQXFDLEVBQ3JDLGFBQTZCLEVBQzdCLEdBQVc7UUFGWCxzQkFBaUIsR0FBakIsaUJBQWlCLENBQW9CO1FBQ3JDLGtCQUFhLEdBQWIsYUFBYSxDQUFnQjtRQUM3QixRQUFHLEdBQUgsR0FBRyxDQUFRO1FBa0I5Qix1QkFBa0IsR0FBRyxDQUFDLFFBQWdCLEVBQUUsT0FBZSxFQUF3QixFQUFFO1lBQy9FLElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLGtCQUFrQixDQUFDLE9BQU8sQ0FBQyxDQUFDLFFBQVEsQ0FBQyxRQUFRLENBQUMsRUFBRTtnQkFDbkYsT0FBTyxTQUFTLENBQUE7YUFDakI7WUFFRCxNQUFNLFdBQVcsR0FBRyxhQUFhLENBQUMsT0FBTyxDQUFDLENBQUE7WUFDMUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQ1o7Z0JBQ0UsWUFBWSxFQUFFLFdBQVcsQ0FBQyxPQUFPLENBQUMsT0FBTzthQUMxQyxFQUNELHNCQUFzQixRQUFRLGNBQWMsT0FBTyxLQUFLLFdBQVcsQ0FBQyxPQUFPLENBQUMsT0FBTyxHQUFHLENBQ3ZGLENBQUE7WUFDRCxPQUFPLFdBQVcsQ0FBQTtRQUNwQixDQUFDLENBQUE7UUFFRCxvQkFBZSxHQUFHLEtBQUssRUFBRSxRQUFnQixFQUE4QixFQUFFO1lBQ3ZFLElBQUksS0FBSyxHQUFzQixTQUFTLENBQUE7WUFDeEMsSUFBSSxTQUFTLENBQUMsUUFBUSxDQUFDLEVBQUU7Z0JBQ3ZCLEtBQUssR0FBRyxNQUFNLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxpQkFBaUIsQ0FBQyxRQUFRLENBQUMsQ0FBQTthQUNqRTtZQUVELElBQUksQ0FBQyxLQUFLLEVBQUU7Z0JBQ1YsS0FBSyxHQUFHLE1BQU0sSUFBSSxDQUFDLGlCQUFpQixDQUFDLGdCQUFnQixDQUFDLFFBQVEsQ0FBQyxDQUFBO2FBQ2hFO1lBRUQsSUFBSSxLQUFLLEVBQUU7Z0JBQ1QsSUFBSSxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQ1o7b0JBQ0UsWUFBWSxFQUFFLEtBQUssQ0FBQyxPQUFPLENBQUMsT0FBTztpQkFDcEMsRUFDRCxlQUFlLFFBQVEsa0JBQWtCLENBQzFDLENBQUE7YUFDRjtZQUVELE9BQU8sS0FBSyxDQUFBO1FBQ2QsQ0FBQyxDQUFBO1FBRUQsaUJBQVksR0FBRyxLQUFLLEVBQUUsUUFBZ0IsRUFBOEIsRUFBRTtZQUNwRSxJQUFJLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyx1QkFBdUIsUUFBUSxhQUFhLENBQUMsQ0FBQTtZQUU1RCxpRkFBaUY7WUFDakYsb0RBQW9EO1lBQ3BELGtJQUFrSTtZQUNsSSxJQUFJLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxFQUFFO2dCQUN4QixPQUFPLFNBQVMsQ0FBQTthQUNqQjtZQUVELE1BQU0sYUFBYSxHQUFHLE1BQU0sSUFBSSxDQUFDLGFBQWEsQ0FBQyxTQUFTLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFBO1lBQ3BFLE9BQU8sYUFBYSxDQUFDLGlCQUFpQixDQUFDLFFBQVEsQ0FBQyxDQUFBO1FBQ2xELENBQUMsQ0FBQTtJQWxFRSxDQUFDO0lBRUcsS0FBSyxDQUFDLGNBQWMsQ0FBQyxRQUFnQixFQUFFLE9BQWU7UUFDM0QsTUFBTSxXQUFXLEdBQUcsSUFBSSxDQUFDLGtCQUFrQixDQUFDLFFBQVEsRUFBRSxPQUFPLENBQUMsQ0FBQTtRQUM5RCxJQUFJLFdBQVcsRUFBRTtZQUNmLE9BQU8sV0FBVyxDQUFBO1NBQ25CO1FBRUQsb0hBQW9IO1FBQ3BILE1BQU0sa0JBQWtCLEdBQXNCLE1BQU0sSUFBSSxDQUFDLGVBQWUsQ0FBQyxRQUFRLENBQUMsQ0FBQTtRQUNsRixJQUFJLGtCQUFrQixFQUFFO1lBQ3RCLE9BQU8sa0JBQWtCLENBQUE7U0FDMUI7UUFFRCxPQUFPLE1BQU0sSUFBSSxDQUFDLFlBQVksQ0FBQyxRQUFRLENBQUMsQ0FBQTtJQUMxQyxDQUFDO0NBb0RGIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgQ3VycmVuY3ksIFRva2VuIH0gZnJvbSAnQHVuaXN3YXAvc2RrLWNvcmUnXG5pbXBvcnQgeyBJVG9rZW5MaXN0UHJvdmlkZXIsIElUb2tlblByb3ZpZGVyLCBOQVRJVkVfTkFNRVNfQllfSUQsIG5hdGl2ZU9uQ2hhaW4gfSBmcm9tICdAdW5pc3dhcC9zbWFydC1vcmRlci1yb3V0ZXInXG5pbXBvcnQgTG9nZ2VyIGZyb20gJ2J1bnlhbidcbmltcG9ydCB7IGlzQWRkcmVzcyB9IGZyb20gJy4uL3V0aWwvaXNBZGRyZXNzJ1xuXG4vKipcbiAqIEN1cnJlbmN5TG9va3VwIHNlYXJjaGVzIG5hdGl2ZSB0b2tlbnMsIHRva2VuIGxpc3RzLCBhbmQgb24gY2hhaW4gdG8gZGV0ZXJtaW5lXG4gKiB0aGUgdG9rZW4gZGV0YWlscyAoY2FsbGVkIEN1cnJlbmN5IGJ5IHRoZSBzZGspIGZvciBhbiBpbnB1dHRlZCBzdHJpbmcuXG4gKi9cbmV4cG9ydCBjbGFzcyBDdXJyZW5jeUxvb2t1cCB7XG4gIGNvbnN0cnVjdG9yKFxuICAgIHByaXZhdGUgcmVhZG9ubHkgdG9rZW5MaXN0UHJvdmlkZXI6IElUb2tlbkxpc3RQcm92aWRlcixcbiAgICBwcml2YXRlIHJlYWRvbmx5IHRva2VuUHJvdmlkZXI6IElUb2tlblByb3ZpZGVyLFxuICAgIHByaXZhdGUgcmVhZG9ubHkgbG9nOiBMb2dnZXJcbiAgKSB7fVxuXG4gIHB1YmxpYyBhc3luYyBzZWFyY2hGb3JUb2tlbih0b2tlblJhdzogc3RyaW5nLCBjaGFpbklkOiBudW1iZXIpOiBQcm9taXNlPEN1cnJlbmN5IHwgdW5kZWZpbmVkPiB7XG4gICAgY29uc3QgbmF0aXZlVG9rZW4gPSB0aGlzLmNoZWNrSWZOYXRpdmVUb2tlbih0b2tlblJhdywgY2hhaW5JZClcbiAgICBpZiAobmF0aXZlVG9rZW4pIHtcbiAgICAgIHJldHVybiBuYXRpdmVUb2tlblxuICAgIH1cblxuICAgIC8vIEF0IHRoaXMgcG9pbnQsIHdlIGtub3cgdGhpcyBpcyBub3QgYSBOYXRpdmVDdXJyZW5jeSBiYXNlZCBvbiB0aGUgY2hlY2sgYWJvdmUsIHNvIHdlIGNhbiBleHBsaWNpdGx5IGNhc3QgdG8gVG9rZW4uXG4gICAgY29uc3QgdG9rZW5Gcm9tVG9rZW5MaXN0OiBUb2tlbiB8IHVuZGVmaW5lZCA9IGF3YWl0IHRoaXMuY2hlY2tUb2tlbkxpc3RzKHRva2VuUmF3KVxuICAgIGlmICh0b2tlbkZyb21Ub2tlbkxpc3QpIHtcbiAgICAgIHJldHVybiB0b2tlbkZyb21Ub2tlbkxpc3RcbiAgICB9XG5cbiAgICByZXR1cm4gYXdhaXQgdGhpcy5jaGVja09uQ2hhaW4odG9rZW5SYXcpXG4gIH1cblxuICBjaGVja0lmTmF0aXZlVG9rZW4gPSAodG9rZW5SYXc6IHN0cmluZywgY2hhaW5JZDogbnVtYmVyKTogQ3VycmVuY3kgfCB1bmRlZmluZWQgPT4ge1xuICAgIGlmICghTkFUSVZFX05BTUVTX0JZX0lEW2NoYWluSWRdIHx8ICFOQVRJVkVfTkFNRVNfQllfSURbY2hhaW5JZF0uaW5jbHVkZXModG9rZW5SYXcpKSB7XG4gICAgICByZXR1cm4gdW5kZWZpbmVkXG4gICAgfVxuXG4gICAgY29uc3QgbmF0aXZlVG9rZW4gPSBuYXRpdmVPbkNoYWluKGNoYWluSWQpXG4gICAgdGhpcy5sb2cuZGVidWcoXG4gICAgICB7XG4gICAgICAgIHRva2VuQWRkcmVzczogbmF0aXZlVG9rZW4ud3JhcHBlZC5hZGRyZXNzLFxuICAgICAgfSxcbiAgICAgIGBGb3VuZCBuYXRpdmUgdG9rZW4gJHt0b2tlblJhd30gZm9yIGNoYWluICR7Y2hhaW5JZH06ICR7bmF0aXZlVG9rZW4ud3JhcHBlZC5hZGRyZXNzfX1gXG4gICAgKVxuICAgIHJldHVybiBuYXRpdmVUb2tlblxuICB9XG5cbiAgY2hlY2tUb2tlbkxpc3RzID0gYXN5bmMgKHRva2VuUmF3OiBzdHJpbmcpOiBQcm9taXNlPFRva2VuIHwgdW5kZWZpbmVkPiA9PiB7XG4gICAgbGV0IHRva2VuOiBUb2tlbiB8IHVuZGVmaW5lZCA9IHVuZGVmaW5lZFxuICAgIGlmIChpc0FkZHJlc3ModG9rZW5SYXcpKSB7XG4gICAgICB0b2tlbiA9IGF3YWl0IHRoaXMudG9rZW5MaXN0UHJvdmlkZXIuZ2V0VG9rZW5CeUFkZHJlc3ModG9rZW5SYXcpXG4gICAgfVxuXG4gICAgaWYgKCF0b2tlbikge1xuICAgICAgdG9rZW4gPSBhd2FpdCB0aGlzLnRva2VuTGlzdFByb3ZpZGVyLmdldFRva2VuQnlTeW1ib2wodG9rZW5SYXcpXG4gICAgfVxuXG4gICAgaWYgKHRva2VuKSB7XG4gICAgICB0aGlzLmxvZy5kZWJ1ZyhcbiAgICAgICAge1xuICAgICAgICAgIHRva2VuQWRkcmVzczogdG9rZW4ud3JhcHBlZC5hZGRyZXNzLFxuICAgICAgICB9LFxuICAgICAgICBgRm91bmQgdG9rZW4gJHt0b2tlblJhd30gaW4gdG9rZW4gbGlzdHMuYFxuICAgICAgKVxuICAgIH1cblxuICAgIHJldHVybiB0b2tlblxuICB9XG5cbiAgY2hlY2tPbkNoYWluID0gYXN5bmMgKHRva2VuUmF3OiBzdHJpbmcpOiBQcm9taXNlPFRva2VuIHwgdW5kZWZpbmVkPiA9PiB7XG4gICAgdGhpcy5sb2cuZGVidWcoYEdldHRpbmcgaW5wdXQgdG9rZW4gJHt0b2tlblJhd30gZnJvbSBjaGFpbmApXG5cbiAgICAvLyBUaGUgSVRva2VuTGlzdFByb3ZpZGVyIGludGVyZmFjZSBleHBlY3RzIGEgbGlzdCBvZiBhZGRyZXNzZXMgdG8gbG9va3VwIHRva2Vucy5cbiAgICAvLyBJZiB0aGlzIGlzbid0IGFuIGFkZHJlc3MsIHdlIGNhbid0IGRvIHRoZSBsb29rdXAuXG4gICAgLy8gaHR0cHM6Ly9naXRodWIuY29tL1VuaXN3YXAvc21hcnQtb3JkZXItcm91dGVyL2Jsb2IvNzFmYWMxOTA1YTMyYWYzNjllMzBlOWNiYjUyZWEzNmU5NzFhYjI3OS9zcmMvcHJvdmlkZXJzL3Rva2VuLXByb3ZpZGVyLnRzI0wyM1xuICAgIGlmICghaXNBZGRyZXNzKHRva2VuUmF3KSkge1xuICAgICAgcmV0dXJuIHVuZGVmaW5lZFxuICAgIH1cblxuICAgIGNvbnN0IHRva2VuQWNjZXNzb3IgPSBhd2FpdCB0aGlzLnRva2VuUHJvdmlkZXIuZ2V0VG9rZW5zKFt0b2tlblJhd10pXG4gICAgcmV0dXJuIHRva2VuQWNjZXNzb3IuZ2V0VG9rZW5CeUFkZHJlc3ModG9rZW5SYXcpXG4gIH1cbn1cbiJdfQ==