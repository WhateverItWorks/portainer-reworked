import angular from 'angular';
import _ from 'lodash-es';
import * as JsonPatch from 'fast-json-patch';
import { FeatureId } from '@/react/portainer/feature-flags/enums';

import {
  KubernetesApplicationDataAccessPolicies,
  KubernetesApplicationDeploymentTypes,
  KubernetesApplicationTypes,
  KubernetesDeploymentTypes,
} from 'Kubernetes/models/application/models';
import KubernetesEventHelper from 'Kubernetes/helpers/eventHelper';
import { KubernetesServiceTypes } from 'Kubernetes/models/service/models';
import { KubernetesPodNodeAffinityNodeSelectorRequirementOperators } from 'Kubernetes/pod/models';
import { KubernetesPodContainerTypes } from 'Kubernetes/pod/models/index';
import KubernetesNamespaceHelper from 'Kubernetes/helpers/namespaceHelper';

function computeTolerations(nodes, application) {
  const pod = application.Pods[0];
  _.forEach(nodes, (n) => {
    n.AcceptsApplication = true;
    n.Expanded = false;
    if (!pod) {
      return;
    }
    n.UnmetTaints = [];
    _.forEach(n.Taints, (t) => {
      const matchKeyMatchValueMatchEffect = _.find(pod.Tolerations, { Key: t.Key, Operator: 'Equal', Value: t.Value, Effect: t.Effect });
      const matchKeyAnyValueMatchEffect = _.find(pod.Tolerations, { Key: t.Key, Operator: 'Exists', Effect: t.Effect });
      const matchKeyMatchValueAnyEffect = _.find(pod.Tolerations, { Key: t.Key, Operator: 'Equal', Value: t.Value, Effect: '' });
      const matchKeyAnyValueAnyEffect = _.find(pod.Tolerations, { Key: t.Key, Operator: 'Exists', Effect: '' });
      const anyKeyAnyValueAnyEffect = _.find(pod.Tolerations, { Key: '', Operator: 'Exists', Effect: '' });

      if (!matchKeyMatchValueMatchEffect && !matchKeyAnyValueMatchEffect && !matchKeyMatchValueAnyEffect && !matchKeyAnyValueAnyEffect && !anyKeyAnyValueAnyEffect) {
        n.AcceptsApplication = false;
        n.UnmetTaints.push(t);
      } else {
        n.AcceptsApplication = true;
      }
    });
  });
  return nodes;
}

// For node requirement format depending on operator value
// see https://kubernetes.io/docs/reference/generated/kubernetes-api/v1.18/#nodeselectorrequirement-v1-core
// Some operators require empty "values" field, some only one element in "values" field, etc

function computeAffinities(nodes, application) {
  if (!application.Pods || application.Pods.length === 0) {
    return nodes;
  }

  const pod = application.Pods[0];
  _.forEach(nodes, (n) => {
    if (pod.NodeSelector) {
      const patch = JsonPatch.compare(n.Labels, pod.NodeSelector);
      _.remove(patch, { op: 'remove' });
      n.UnmatchedNodeSelectorLabels = _.map(patch, (i) => {
        return { key: _.trimStart(i.path, '/'), value: i.value };
      });
      if (n.UnmatchedNodeSelectorLabels.length) {
        n.AcceptsApplication = false;
      }
    }

    if (pod.Affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution) {
      const unmatchedTerms = _.map(pod.Affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms, (t) => {
        const unmatchedExpressions = _.map(t.matchExpressions, (e) => {
          const exists = {}.hasOwnProperty.call(n.Labels, e.key);
          const isIn = exists && _.includes(e.values, n.Labels[e.key]);
          if (
            (e.operator === KubernetesPodNodeAffinityNodeSelectorRequirementOperators.EXISTS && exists) ||
            (e.operator === KubernetesPodNodeAffinityNodeSelectorRequirementOperators.DOES_NOT_EXIST && !exists) ||
            (e.operator === KubernetesPodNodeAffinityNodeSelectorRequirementOperators.IN && isIn) ||
            (e.operator === KubernetesPodNodeAffinityNodeSelectorRequirementOperators.NOT_IN && !isIn) ||
            (e.operator === KubernetesPodNodeAffinityNodeSelectorRequirementOperators.GREATER_THAN && exists && parseInt(n.Labels[e.key], 10) > parseInt(e.values[0], 10)) ||
            (e.operator === KubernetesPodNodeAffinityNodeSelectorRequirementOperators.LOWER_THAN && exists && parseInt(n.Labels[e.key], 10) < parseInt(e.values[0], 10))
          ) {
            return;
          }
          return e;
        });
        return _.without(unmatchedExpressions, undefined);
      });
      _.remove(unmatchedTerms, (i) => i.length === 0);
      n.UnmatchedNodeAffinities = unmatchedTerms;
      if (n.UnmatchedNodeAffinities.length) {
        n.AcceptsApplication = false;
      }
    }
  });
  return nodes;
}

function computePlacements(nodes, application) {
  nodes = computeTolerations(nodes, application);
  nodes = computeAffinities(nodes, application);
  return nodes;
}

class KubernetesApplicationController {
  /* @ngInject */
  constructor(
    $async,
    $state,
    clipboard,
    Notifications,
    LocalStorage,
    KubernetesResourcePoolService,
    KubernetesApplicationService,
    KubernetesEventService,
    KubernetesStackService,
    KubernetesPodService,
    KubernetesNodeService,
    StackService
  ) {
    this.$async = $async;
    this.$state = $state;
    this.clipboard = clipboard;
    this.Notifications = Notifications;
    this.LocalStorage = LocalStorage;
    this.KubernetesResourcePoolService = KubernetesResourcePoolService;
    this.StackService = StackService;

    this.KubernetesApplicationService = KubernetesApplicationService;
    this.KubernetesEventService = KubernetesEventService;
    this.KubernetesStackService = KubernetesStackService;
    this.KubernetesPodService = KubernetesPodService;
    this.KubernetesNodeService = KubernetesNodeService;

    this.KubernetesApplicationDeploymentTypes = KubernetesApplicationDeploymentTypes;
    this.KubernetesApplicationTypes = KubernetesApplicationTypes;
    this.KubernetesDeploymentTypes = KubernetesDeploymentTypes;

    this.ApplicationDataAccessPolicies = KubernetesApplicationDataAccessPolicies;
    this.KubernetesServiceTypes = KubernetesServiceTypes;
    this.KubernetesPodContainerTypes = KubernetesPodContainerTypes;

    this.onInit = this.onInit.bind(this);
    this.getApplication = this.getApplication.bind(this);
    this.getApplicationAsync = this.getApplicationAsync.bind(this);
    this.getEvents = this.getEvents.bind(this);
    this.getEventsAsync = this.getEventsAsync.bind(this);
  }

  selectTab(index) {
    this.LocalStorage.storeActiveTab('application', index);
  }

  showEditor() {
    this.state.showEditorTab = true;
    this.selectTab(3);
  }

  isSystemNamespace() {
    return KubernetesNamespaceHelper.isSystemNamespace(this.application.ResourcePool);
  }

  hasEventWarnings() {
    return this.state.eventWarningCount;
  }

  /**
   * EVENTS
   */
  async getEventsAsync() {
    try {
      this.state.eventsLoading = true;
      const events = await this.KubernetesEventService.get(this.state.params.namespace);
      this.events = _.filter(
        events,
        (event) =>
          event.Involved.uid === this.application.Id ||
          event.Involved.uid === this.application.ServiceId ||
          _.find(this.application.Pods, (pod) => pod.Id === event.Involved.uid) !== undefined
      );
      this.state.eventWarningCount = KubernetesEventHelper.warningCount(this.events);
    } catch (err) {
      this.Notifications.error('Failure', err, 'Unable to retrieve application related events');
    } finally {
      this.state.eventsLoading = false;
    }
  }

  getEvents() {
    return this.$async(this.getEventsAsync);
  }

  /**
   * APPLICATION
   */
  async getApplicationAsync() {
    try {
      this.state.dataLoading = true;
      const [application, nodes] = await Promise.all([
        this.KubernetesApplicationService.get(this.state.params.namespace, this.state.params.name),
        this.KubernetesNodeService.get(),
      ]);
      this.application = application;

      this.placements = computePlacements(nodes, this.application);
      this.state.placementWarning = _.find(this.placements, { AcceptsApplication: true }) ? false : true;

      if (application.StackId) {
        const file = await this.StackService.getStackFile(application.StackId);
        this.stackFileContent = file;
      }
    } catch (err) {
      this.Notifications.error('Failure', err, 'Unable to retrieve application details');
    } finally {
      this.state.dataLoading = false;
    }
  }

  getApplication() {
    return this.$async(this.getApplicationAsync);
  }

  async onInit() {
    this.limitedFeature = FeatureId.K8S_ROLLING_RESTART;

    this.state = {
      activeTab: 0,
      currentName: this.$state.$current.name,
      showEditorTab: false,
      DisplayedPanel: 'pods',
      eventsLoading: true,
      dataLoading: true,
      viewReady: false,
      params: {
        namespace: this.$transition$.params().namespace,
        name: this.$transition$.params().name,
      },
      appType: this.KubernetesDeploymentTypes.APPLICATION_FORM,
      eventWarningCount: 0,
      placementWarning: false,
      expandedNote: false,
      publicUrl: this.endpoint.PublicURL,
    };

    this.state.activeTab = this.LocalStorage.getActiveTab('application');

    this.formValues = {
      Note: '',
      SelectedRevision: undefined,
    };

    await this.getApplication();
    await this.getEvents();
    this.state.viewReady = true;
  }

  $onInit() {
    return this.$async(this.onInit);
  }

  $onDestroy() {
    if (this.state.currentName !== this.$state.$current.name) {
      this.LocalStorage.storeActiveTab('application', 0);
    }
  }
}

export default KubernetesApplicationController;
angular.module('portainer.kubernetes').controller('KubernetesApplicationController', KubernetesApplicationController);
