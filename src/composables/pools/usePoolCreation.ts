import { balancerSubgraphService } from '@/services/balancer/subgraph/balancer-subgraph.service';
import { FullPool, PoolType } from '@/services/balancer/subgraph/types';
import CalculatorService from '@/services/pool/calculator/calculator.sevice';
import { getAddress } from '@ethersproject/address';
import { flatten, minBy, sumBy } from 'lodash';
import { ref, reactive, toRefs, watch, computed, toRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { useQuery } from 'vue-query';
import usePoolsQuery from '@/composables/queries/usePoolsQuery';
import useTransactions from '@/composables/useTransactions';
import useEthers from '@/composables/useEthers';
import useTokens from '../useTokens';
import useWeb3 from '@/services/web3/useWeb3';
import { balancerService } from '@/services/balancer/balancer.service';
import { AddressZero } from '@ethersproject/constants';
import { bnum, scale } from '@/lib/utils';

import BigNumber from 'bignumber.js';
import { BigNumber as EPBigNumber } from '@ethersproject/bignumber';
import { toNormalizedWeights } from '@balancer-labs/balancer-js';

export type TokenWeight = {
  tokenAddress: string;
  weight: number;
  isLocked: boolean;
  amount: number;
  id: number;
};

type FeeManagementType = 'governance' | 'self';
type FeeType = 'fixed' | 'dynamic';
type FeeController = 'self' | 'other';
type CreateState = 'none' | 'creating' | 'created' | 'failed';
type JoinState = 'non' | 'joining' | 'joined' | 'failed';

const poolCreationState = reactive({
  name: 'MyPool',
  tokenWeights: [] as TokenWeight[],
  activeStep: 0,
  initialFee: '0',
  isFeeGovManaged: false,
  feeManagementType: 'governance' as FeeManagementType,
  feeType: 'fixed' as FeeType,
  feeController: 'self' as FeeController,
  thirdPartyFeeController: '',
  fee: '0',
  tokensList: [] as string[],
  poolId: '' as string,
  poolAddress: '',
  createState: 'none' as CreateState,
  joinState: 'none' as JoinState
});

async function getSimilarPools(tokensInPool: string[]) {
  const queryArgs = {
    first: 3,
    where: {
      tokensList: tokensInPool
    }
  };
  const attrs = {
    tokens: {
      symbol: true
    }
  };
  const response = await balancerSubgraphService.pools.get(queryArgs, attrs);
  return response;
}

export default function usePoolCreation() {
  const { balanceFor, tokens, balances, priceFor, getToken } = useTokens();
  const { account, getProvider } = useWeb3();
  const { txListener } = useEthers();
  const { addTransaction } = useTransactions();
  const { t } = useI18n();
  watch(
    () => poolCreationState.tokenWeights,
    () => {
      poolCreationState.tokensList = poolCreationState.tokenWeights.map(
        w => w.tokenAddress
      );
    },
    {
      deep: true
    }
  );

  const updateTokenWeights = (weights: TokenWeight[]) => {
    poolCreationState.tokenWeights = weights;
  };

  const sortTokenWeights = () => {
    poolCreationState.tokenWeights.sort((tokenA, tokenB) => {
      return tokenA.tokenAddress > tokenB.tokenAddress ? 1 : -1;
    });
  };
  const proceed = () => {
    poolCreationState.activeStep += 1;
  };

  const setFeeManagement = (type: FeeManagementType) => {
    poolCreationState.feeManagementType = type;
  };

  const setFeeType = (type: FeeType) => {
    poolCreationState.feeType = type;
  };

  const setStep = (step: number) => {
    poolCreationState.activeStep = 0;
  };

  const setFeeController = (controller: FeeController) => {
    poolCreationState.feeController = controller;
  };

  const setTrpController = (address: string) => {
    poolCreationState.thirdPartyFeeController = address;
  };

  const getScaledAmounts = (): BigNumber[] => {
    const scaledAmounts: BigNumber[] = poolCreationState.tokenWeights.map(
      (token: TokenWeight) => {
        const tokenInfo = getToken(token.tokenAddress);
        const amount = new BigNumber(token.amount);
        const scaledAmount = scale(amount, tokenInfo.decimals);
        return scaledAmount;
      }
    );
    return scaledAmounts;
  };

  const getPoolSymbol = (): string => {
    const tokenSymbols = poolCreationState.tokenWeights.map(
      (token: TokenWeight) => {
        const weightRounded = Math.round(token.weight);
        const tokenInfo = getToken(token.tokenAddress);
        return `${Math.round(weightRounded)}${tokenInfo.symbol}`;
      }
    );

    return tokenSymbols.join('-');
  };

  const createPool = async () => {
    sortTokenWeights();
    const provider = getProvider();
    try {
      poolCreationState.createState = 'creating';
      const tx = await balancerService.pools.weighted.create(
        provider,
        poolCreationState.name,
        getPoolSymbol(),
        '0.01',
        poolCreationState.tokenWeights,
        // poolCreationState.thirdPartyFeeController
        AddressZero
      );

      addTransaction({
        id: tx.hash,
        type: 'tx',
        action: 'createpool',
        summary: t('transactionSummary.createPool'),
        details: {
          name: poolCreationState.name
        }
      });

      txListener(tx, {
        onTxConfirmed: async () => {
          const poolDetails = await balancerService.pools.weighted.details(
            provider,
            tx
          );
          poolCreationState.poolId = poolDetails.id;
          poolCreationState.poolAddress = poolDetails.address;
          poolCreationState.createState = 'created';
        },
        onTxFailed: () => {
          poolCreationState.createState = 'failed';
        }
      });
    } catch (e) {
      console.log(e);
      poolCreationState.createState = 'failed';
    }
  };

  const joinPool = async () => {
    sortTokenWeights();
    const provider = getProvider();
    try {
      poolCreationState.joinState = 'joining';
      const tx = await balancerService.pools.weighted.initJoin(
        provider,
        poolCreationState.poolId,
        account.value,
        account.value,
        poolCreationState.tokenWeights,
        getScaledAmounts()
      );

      console.log('Got join pool response: ', tx);

      addTransaction({
        id: tx.hash,
        type: 'tx',
        action: 'invest',
        summary: t('transactionSummary.investInPool')
      });

      txListener(tx, {
        onTxConfirmed: () => {
          poolCreationState.joinState = 'joined';
        },
        onTxFailed: () => {
          poolCreationState.joinState = 'failed';
        }
      });
    } catch (e) {
      console.log(e);
      poolCreationState.joinState = 'failed';
    }
  };

  const tokensList = computed(() => poolCreationState.tokensList);

  const result = usePoolsQuery(tokensList, {}, { isExactTokensList: true });
  const {
    data: similarPoolsResponse,
    isLoading: isLoadingSimilarPools
  } = usePoolsQuery(tokensList, {}, { isExactTokensList: true });
  const similarPools = computed(() => {
    return flatten(similarPoolsResponse.value?.pages.map(p => p.pools));
  });

  const existingPool = computed(() => {
    if (!similarPools.value?.length) return null;
    const similarPool = similarPools.value.find(
      pool => pool.swapFee === poolCreationState.initialFee
    );
    return similarPool;
  });

  const optimisedLiquidity = computed(() => {
    // need to filter out the empty tokens just in case
    const validTokens = tokensList.value.filter(t => t !== '');
    const optimisedLiquidity = {};
    // token with the lowest balance is the bottleneck
    const bottleneckToken = minBy(
      validTokens,
      token => Number(balanceFor(token)) * Number(priceFor(token))
    );
    if (!bottleneckToken) return optimisedLiquidity;

    const bottleneckWeight =
      poolCreationState.tokenWeights.find(
        t => t.tokenAddress === bottleneckToken
      )?.weight || 0;

    const bip = bnum(priceFor(bottleneckToken || '0'))
      .times(balanceFor(bottleneckToken))
      .div(bottleneckWeight);
    for (const token of poolCreationState.tokenWeights) {
      // get the price for a single token
      const tokenPrice = bnum(priceFor(token.tokenAddress));
      // the usd value needed for its weight
      const liquidityRequired = bip.times(token.weight);
      const balanceRequired = liquidityRequired.div(tokenPrice);
      optimisedLiquidity[token.tokenAddress] = {
        liquidityRequired: liquidityRequired.toString(),
        balanceRequired: balanceRequired.toString()
      };
    }
    return optimisedLiquidity;
  });

  const maxInitialLiquidity = computed(() =>
    sumBy(Object.values(optimisedLiquidity.value), (liq: any) =>
      Number(liq.liquidityRequired)
    )
  );

  const totalLiquidity = computed(() => {
    return sumBy(tokensList.value, t => priceFor(t) * Number(balanceFor(t)));
  });

  return {
    ...toRefs(poolCreationState),
    updateTokenWeights,
    proceed,
    setFeeManagement,
    setFeeType,
    setFeeController,
    setTrpController,
    setStep,
    optimisedLiquidity,
    similarPools,
    isLoadingSimilarPools,
    existingPool,
    totalLiquidity,
    maxInitialLiquidity,
    getPoolSymbol,
    createPool,
    joinPool
  };
}